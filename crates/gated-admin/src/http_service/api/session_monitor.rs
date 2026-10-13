use std::sync::Arc;

use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use gated_core::recordings::{AsciiCast, SessionRecordings, TerminalRecordingItem};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::Recording::{self, RecordingKind};
use poem::web::websocket::{Message, WebSocket};
use poem::web::{Data, Path};
use poem::{handler, IntoResponse};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::json;
use tokio::sync::{broadcast, Mutex};
use tracing::*;
use uuid::Uuid;

/// Read-only live monitor for an active session's terminal output.
///
/// Admin-only: this handler is mounted under `/admin/api`, whose whole nest is
/// wrapped with `endpoint_admin_auth` at the router level (see
/// `http_service::mod`), so a non-admin caller is rejected with 403 during the
/// WebSocket handshake, before this handler runs.
///
/// It mirrors the *output half* of the web terminal / recording live-stream but
/// is keyed by **session** id: it resolves the session's live terminal
/// recording and forwards its live broadcast. It is strictly READ-ONLY — the
/// client -> server half of the socket is dropped, so nothing a monitoring
/// admin sends can ever reach the monitored session's byte stream.
#[handler]
pub async fn api_session_monitor(
    ws: WebSocket,
    db: Data<&SharedDatabaseConnection>,
    recordings: Data<&Arc<Mutex<SessionRecordings>>>,
    Path(session_id): Path<Uuid>,
) -> impl IntoResponse {
    // Resolve the session's live terminal feed before the upgrade so we can
    // report liveness in the opening frame.
    let receiver = resolve_live_terminal(&db, &recordings, session_id).await;

    ws.on_upgrade(move |socket| async move {
        // READ-ONLY: drop the client -> server half entirely.
        let (mut sink, _source) = socket.split();

        sink.send(Message::Text(serde_json::to_string(&json!({
            "start": true,
            "live": receiver.is_some(),
        }))?))
        .await?;

        let Some(mut receiver) = receiver else {
            // Session is not live (ended, never recorded, or not found). Close
            // cleanly with a reason instead of leaving the socket idle.
            sink.send(Message::Text(serde_json::to_string(&json!({
                "end": true,
                "reason": "session is not live or does not exist",
            }))?))
            .await?;
            return Ok::<(), anyhow::Error>(());
        };

        loop {
            match receiver.recv().await {
                Ok(data) => {
                    // The live broadcast carries serialized `TerminalRecordingItem`
                    // frames; convert to asciicast for a renderable read-only feed.
                    let Ok(item) = serde_json::from_slice::<TerminalRecordingItem>(&data) else {
                        continue;
                    };
                    let cast: AsciiCast = item.into();
                    let msg = serde_json::to_string(&json!({ "data": cast }))?;
                    if sink.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
                // Producer dropped the recording writer: session output ended.
                Err(broadcast::error::RecvError::Closed) => break,
                // Slow consumer; skip ahead rather than tearing the monitor down.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }

        let _ = sink
            .send(Message::Text(serde_json::to_string(
                &json!({ "end": true }),
            )?))
            .await;
        Ok::<(), anyhow::Error>(())
    })
}

/// Resolve the live terminal recording feed for a session.
///
/// A session may own several recordings (terminal, traffic, ...); the live
/// broadcast map is keyed by *recording* id, so we look up the session's
/// terminal recordings (newest first) and subscribe to the first one that still
/// has an open live writer. Returns `None` when no terminal recording of the
/// session is currently live.
async fn resolve_live_terminal(
    db: &SharedDatabaseConnection,
    recordings: &Arc<Mutex<SessionRecordings>>,
    session_id: Uuid,
) -> Option<broadcast::Receiver<Bytes>> {
    let db = gated_core::db_required(db).await.ok()?;
    let recs = Recording::Entity::find()
        .filter(Recording::Column::SessionId.eq(session_id))
        .filter(Recording::Column::Kind.eq(RecordingKind::Terminal))
        .order_by_desc(Recording::Column::Started)
        .all(&db)
        .await
        .ok()?;

    let recordings = recordings.lock().await;
    for r in recs {
        if let Some(rx) = recordings.subscribe_live(&r.id).await {
            debug!(%session_id, recording_id = %r.id, "session monitor subscribed to live terminal");
            return Some(rx);
        }
    }
    None
}
