use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use gated_common::GatedError;
use gated_core::recordings::SessionRecordings;
use gated_core::SharedDatabaseConnection;
use gated_core::{SessionSnapshot, State};
use poem::session::Session;
use poem::web::websocket::{Message, WebSocket};
use poem::web::Data;
use poem::{handler, IntoResponse};
use poem_openapi::param::Query;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, OpenApi};
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use tokio::sync::{Mutex, RwLock};

use super::pagination::{PaginatedResponse, PaginationParams};
use super::sessions_detail::write_session_delete_audit;
use super::AnySecurityScheme;
use crate::http_service::common::RequestAuthorization;

pub struct Api;

#[derive(ApiResponse)]
enum GetSessionsResponse {
    #[oai(status = 200)]
    Ok(Json<PaginatedResponse<SessionSnapshot>>),
}

#[derive(ApiResponse)]
enum CloseAllSessionsResponse {
    #[oai(status = 201)]
    Ok,
}

#[derive(ApiResponse)]
enum DeleteClosedSessionsResponse {
    /// Body is the number of session records deleted.
    #[oai(status = 200)]
    Ok(Json<u64>),
}

#[OpenApi]
impl Api {
    #[oai(path = "/sessions", method = "get", operation_id = "get_sessions")]
    async fn api_get_all_sessions(
        &self,
        db: Data<&SharedDatabaseConnection>,
        offset: Query<Option<u64>>,
        limit: Query<Option<u64>>,
        active_only: Query<Option<bool>>,
        logged_in_only: Query<Option<bool>>,
        _sec_scheme: AnySecurityScheme,
    ) -> poem::Result<GetSessionsResponse> {
        use gated_db_entities::Session;

        let db = gated_core::db_required(&db).await?;
        let mut q = Session::Entity::find()
            .filter(Session::Column::Protocol.ne("ManagementHTTP"))
            .order_by_desc(Session::Column::Started);

        if active_only.unwrap_or(false) {
            q = q.filter(Session::Column::Ended.is_null());
        }
        if logged_in_only.unwrap_or(false) {
            q = q.filter(Session::Column::Username.is_not_null());
        }

        Ok(GetSessionsResponse::Ok(Json(
            PaginatedResponse::new(
                q,
                PaginationParams {
                    limit: *limit,
                    offset: *offset,
                },
                &db,
                Into::into,
            )
            .await?,
        )))
    }

    /// Close every live session. Admin-only — the whole `/admin/api` nest is
    /// wrapped with `endpoint_admin_auth` (see `http_service::mod`), so a
    /// non-admin caller is rejected with 403 before reaching this handler.
    #[oai(
        path = "/sessions",
        method = "delete",
        operation_id = "close_all_sessions"
    )]
    async fn api_close_all_sessions(
        &self,
        state: Data<&Arc<RwLock<State>>>,
        session: &Session,
        _sec_scheme: AnySecurityScheme,
    ) -> poem::Result<CloseAllSessionsResponse> {
        let state = state.write().await;

        for s in state.sessions.values() {
            let mut session = s.lock().await;
            session.handle.close();
        }

        session.purge();

        Ok(CloseAllSessionsResponse::Ok)
    }

    /// Delete all ended (historical) session records and their attached
    /// recordings + log rows. Live sessions are left untouched.
    #[oai(
        path = "/sessions/closed",
        method = "delete",
        operation_id = "delete_closed_sessions"
    )]
    async fn api_delete_closed_sessions(
        &self,
        db: Data<&SharedDatabaseConnection>,
        recordings: Data<&Arc<Mutex<SessionRecordings>>>,
        _sec_scheme: AnySecurityScheme,
        auth: Data<&RequestAuthorization>,
    ) -> Result<DeleteClosedSessionsResponse, GatedError> {
        use gated_db_entities::{LogEntry, Recording, Session};

        let db = gated_core::db_required(&db).await?;
        let closed: Vec<Session::Model> = Session::Entity::find()
            .filter(Session::Column::Ended.is_not_null())
            .all(&db)
            .await?;
        let ids: Vec<uuid::Uuid> = closed.iter().map(|s| s.id).collect();
        if ids.is_empty() {
            return Ok(DeleteClosedSessionsResponse::Ok(Json(0)));
        }

        let recs = Recording::Entity::find()
            .filter(Recording::Column::SessionId.is_in(ids.clone()))
            .all(&db)
            .await?;

        // Audit the bulk wipe BEFORE destroying anything: this endpoint can
        // erase all historical sessions, recordings and log rows at once, so
        // the deletion itself must leave a durable, non-self-deletable trail.
        let log_count = LogEntry::Entity::find()
            .filter(LogEntry::Column::SessionId.is_in(ids.clone()))
            .count(&db)
            .await?;
        write_session_delete_audit(
            &db,
            &ids,
            recs.len() as u64,
            log_count,
            ids.len() as u64,
            auth.username().map(String::as_str).unwrap_or("admin-token"),
        )
        .await?;
        {
            let recordings = recordings.lock().await;
            for r in &recs {
                let _ = recordings.remove(&r.session_id, &r.name).await;
            }
        }
        Recording::Entity::delete_many()
            .filter(Recording::Column::SessionId.is_in(ids.clone()))
            .exec(&db)
            .await?;
        LogEntry::Entity::delete_many()
            .filter(LogEntry::Column::SessionId.is_in(ids.clone()))
            .exec(&db)
            .await?;
        let res = Session::Entity::delete_many()
            .filter(Session::Column::Ended.is_not_null())
            .exec(&db)
            .await?;

        Ok(DeleteClosedSessionsResponse::Ok(Json(res.rows_affected)))
    }
}

#[handler]
pub async fn api_get_sessions_changes_stream(
    ws: WebSocket,
    state: Data<&Arc<RwLock<State>>>,
) -> impl IntoResponse {
    let mut receiver = state.write().await.subscribe();

    ws.on_upgrade(|socket| async move {
        let (mut sink, _) = socket.split();

        while receiver.recv().await.is_ok() {
            sink.send(Message::Text("".to_string())).await?;
        }

        Ok::<(), anyhow::Error>(())
    })
}
