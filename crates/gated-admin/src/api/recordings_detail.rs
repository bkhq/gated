use axum::body::Body;
use axum::extract::Path;
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::response::Response;
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use std::sync::Arc;
use utoipa_axum::router::OpenApiRouter;

use anyhow::Context;
use futures::{SinkExt, StreamExt};
use gated_core::SharedDatabaseConnection;
use gated_core::recordings::{AsciiCast, SessionRecordings, TerminalRecordingItem};
use gated_db_entities::Recording::{self, RecordingKind};
use gated_protocol_http::recording::{HttpProxyRecordingItem, HttpProxyRecordingItemApiObject};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::json;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tokio_util::io::ReaderStream;
use tracing::*;
use uuid::Uuid;

use super::AnySecurityScheme;

api_response! {
    enum GetRecordingResponse {
        #[oai(status = 200)]
        Ok(Json<Recording::Model>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum GetHttpProxyRecordingResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<HttpProxyRecordingItemApiObject>>),
    }
}
#[utoipa::path(get, path = "/recordings/{id}", operation_id = "get_recording")]
async fn api_get_recording(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetRecordingResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let recording = Recording::Entity::find_by_id(id.0)
        .one(&db)
        .await
        .map_err(GatedError::other)?;

    match recording {
        Some(recording) => Ok(GetRecordingResponse::Ok(Json(recording))),
        None => Ok(GetRecordingResponse::NotFound),
    }
}

#[utoipa::path(
    get,
    path = "/recordings/{id}/http-proxy",
    operation_id = "get_http_proxy_recording"
)]
async fn api_get_recording_http_proxy(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    recordings: Data<Arc<Mutex<SessionRecordings>>>,
) -> Result<GetHttpProxyRecordingResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let recording = Recording::Entity::find_by_id(id.0)
        .filter(Recording::Column::Kind.eq(RecordingKind::HttpProxy))
        .one(&db)
        .await
        .map_err(GatedError::other)?;

    let Some(recording) = recording else {
        return Err(GatedError::NotFound);
    };

    let path = {
        recordings
            .lock()
            .await
            .path_for(&recording.session_id, &recording.name)
    };

    let file = File::open(&path).await.map_err(GatedError::other)?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();
    let mut content = Vec::new();

    while let Some(line) = lines.next_line().await.context("reading recording")? {
        let item: HttpProxyRecordingItem =
            serde_json::from_str(&line).context("deserializing recording item")?;
        content.push(HttpProxyRecordingItemApiObject::from(item));
    }

    Ok(GetHttpProxyRecordingResponse::Ok(Json(content)))
}

pub async fn api_get_recording_cast(
    db: Data<SharedDatabaseConnection>,
    recordings: Data<Arc<Mutex<SessionRecordings>>>,
    id: Path<Uuid>,
) -> Result<String, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let recording = Recording::Entity::find_by_id(id.0)
        .filter(Recording::Column::Kind.eq(RecordingKind::Terminal))
        .one(&db)
        .await
        .map_err(GatedError::other)?;

    let Some(recording) = recording else {
        return Err(GatedError::NotFound);
    };

    let path = {
        recordings
            .lock()
            .await
            .path_for(&recording.session_id, &recording.name)
    };

    let mut response = vec![]; //String::new();

    let mut last_size = (0, 0);
    let file = File::open(&path).await.map_err(GatedError::other)?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();
    while let Some(line) = lines.next_line().await.map_err(GatedError::other)? {
        let entry: TerminalRecordingItem =
            serde_json::from_str(&line[..]).map_err(GatedError::other)?;
        let asciicast: AsciiCast = entry.into();
        response.push(serde_json::to_string(&asciicast).map_err(GatedError::other)?);
        if let AsciiCast::Header { width, height, .. } = asciicast {
            last_size = (width, height);
        }
    }

    response.insert(
        0,
        serde_json::to_string(&AsciiCast::Header {
            time: 0.0,
            version: 2,
            width: last_size.0,
            height: last_size.1,
            title: recording.name,
        })
        .map_err(GatedError::other)?,
    );

    Ok(response.join("\n"))
}

pub async fn api_get_recording_tcpdump(
    db: Data<SharedDatabaseConnection>,
    recordings: Data<Arc<Mutex<SessionRecordings>>>,
    id: Path<Uuid>,
) -> Result<Body, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let recording = Recording::Entity::find_by_id(id.0)
        .filter(Recording::Column::Kind.eq(RecordingKind::Traffic))
        .one(&db)
        .await
        .map_err(GatedError::other)?;

    let Some(recording) = recording else {
        return Err(GatedError::NotFound);
    };

    let path = {
        recordings
            .lock()
            .await
            .path_for(&recording.session_id, &recording.name)
    };

    let file = File::open(path).await.map_err(GatedError::other)?;

    Ok(Body::from_stream(ReaderStream::new(file)))
}

pub async fn api_get_recording_stream(
    ws: WebSocketUpgrade,
    recordings: Data<Arc<Mutex<SessionRecordings>>>,
    id: Path<Uuid>,
) -> Response {
    let recordings = recordings.lock().await;
    let receiver = recordings.subscribe_live(&id).await;

    ws.on_upgrade(|socket| async move {
        let (mut sink, _) = socket.split();

        let _ = async {
            sink.send(Message::Text(
                serde_json::to_string(&json!({
                    "start": true,
                    "live": receiver.is_some(),
                }))?
                .into(),
            ))
            .await?;

            if let Some(mut receiver) = receiver {
                tokio::spawn(async move {
                    if let Err(error) = async {
                        while let Ok(data) = receiver.recv().await {
                            let content: TerminalRecordingItem = serde_json::from_slice(&data)?;
                            let cast: AsciiCast = content.into();
                            let msg = serde_json::to_string(&json!({ "data": cast }))?;
                            sink.send(Message::Text(msg.into())).await?;
                        }
                        sink.send(Message::Text(
                            serde_json::to_string(&json!({
                                "end": true,
                            }))?
                            .into(),
                        ))
                        .await?;
                        Ok::<(), anyhow::Error>(())
                    }
                    .await
                    {
                        error!(%error, "Livestream error:");
                    }
                });
            }

            Ok::<(), anyhow::Error>(())
        }
        .await;
    })
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_recording, api_get_recording_http_proxy,)
}
