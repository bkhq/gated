use crate::http_service::session::Session;
use axum::extract::Query;
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::response::Response;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use serde::Deserialize;
use std::sync::Arc;
use utoipa::IntoParams;
use utoipa_axum::router::OpenApiRouter;

use futures::{SinkExt, StreamExt};
use gated_common::GatedError;
use gated_core::SharedDatabaseConnection;
use gated_core::recordings::SessionRecordings;
use gated_core::{SessionSnapshot, State};
use sea_orm::{ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder};
use tokio::sync::{Mutex, RwLock};

use super::AnySecurityScheme;
use super::pagination::{PaginatedResponse, PaginationParams};
use super::sessions_detail::write_session_delete_audit;
use crate::http_service::common::RequestAuthorization;

api_response! {
    enum GetSessionsResponse {
        #[oai(status = 200)]
        Ok(Json<PaginatedResponse<SessionSnapshot>>),
    }
}

api_response! {
    enum CloseAllSessionsResponse {
        #[oai(status = 201)]
        Ok,
    }
}

api_response! {
    enum DeleteClosedSessionsResponse {
        /// Body is the number of session records deleted.
        #[oai(status = 200)]
        Ok(Json<u64>),
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct GetAllSessionsQuery {
    offset: Option<u64>,
    limit: Option<u64>,
    active_only: Option<bool>,
    closed_only: Option<bool>,
    logged_in_only: Option<bool>,
    /// Protocol family: `ssh`, `mysql`, `postgres` or `http`.
    protocol: Option<String>,
    /// Matches the username or the target snapshot.
    search: Option<String>,
    /// Only sessions started at or after this time.
    since: Option<chrono::DateTime<chrono::Utc>>,
    target_id: Option<uuid::Uuid>,
    username: Option<String>,
}

/// Session protocol names that belong to a protocol family filter.
fn protocol_family(family: &str) -> Option<&'static [&'static str]> {
    match family {
        "ssh" => Some(&["SSH", "WebSSH", "WebSFTP"]),
        "mysql" => Some(&["MySQL", "WebMySQL"]),
        "postgres" => Some(&["PostgreSQL", "WebPostgreSQL"]),
        "http" => Some(&["HTTP", "Http", "Kubernetes"]),
        _ => None,
    }
}

#[utoipa::path(
    get,
    path = "/sessions",
    operation_id = "get_sessions",
    params(GetAllSessionsQuery)
)]
async fn api_get_all_sessions(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    Query(query): Query<GetAllSessionsQuery>,
) -> Result<GetSessionsResponse, GatedError> {
    let GetAllSessionsQuery {
        offset,
        limit,
        active_only,
        closed_only,
        logged_in_only,
        protocol,
        search,
        since,
        target_id,
        username,
    } = query;
    use gated_db_entities::Session;

    let db = gated_core::db_required(&db).await?;
    let mut q = Session::Entity::find()
        .filter(Session::Column::Protocol.ne("ManagementHTTP"))
        .order_by_desc(Session::Column::Started);

    if active_only.unwrap_or(false) {
        q = q.filter(Session::Column::Ended.is_null());
    }
    if closed_only.unwrap_or(false) {
        q = q.filter(Session::Column::Ended.is_not_null());
    }
    if logged_in_only.unwrap_or(false) {
        q = q.filter(Session::Column::Username.is_not_null());
    }
    if let Some(protocol) = protocol {
        // An unknown family matches nothing.
        let names = protocol_family(&protocol).unwrap_or(&[]);
        q = q.filter(Session::Column::Protocol.is_in(names.iter().copied()));
    }
    if let Some(search) = search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let mut condition = Condition::any()
            .add(Session::Column::Username.contains(search))
            .add(Session::Column::TargetSnapshot.contains(search));
        if let Ok(id) = uuid::Uuid::parse_str(search) {
            condition = condition.add(Session::Column::Id.eq(id));
        }
        q = q.filter(condition);
    }
    if let Some(since) = since {
        q = q.filter(Session::Column::Started.gte(since));
    }
    if let Some(target_id) = target_id {
        // The snapshot is the serialized target, so its id appears verbatim.
        q = q.filter(Session::Column::TargetSnapshot.contains(format!("\"id\":\"{target_id}\"")));
    }
    if let Some(username) = username {
        q = q.filter(Session::Column::Username.eq(username));
    }

    Ok(GetSessionsResponse::Ok(Json(
        PaginatedResponse::new(q, PaginationParams { limit, offset }, &db, Into::into).await?,
    )))
}

/// Close every live session. Admin-only — the whole `/admin/api` nest is
/// wrapped with `require_admin` (see `http_service::mod`), so a
/// non-admin caller is rejected with 403 before reaching this handler.
#[utoipa::path(delete, path = "/sessions", operation_id = "close_all_sessions")]
async fn api_close_all_sessions(
    state: Data<Arc<RwLock<State>>>,
    session: Session,
    _sec_scheme: AnySecurityScheme,
) -> Result<CloseAllSessionsResponse, GatedError> {
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
#[utoipa::path(
    delete,
    path = "/sessions/closed",
    operation_id = "delete_closed_sessions"
)]
async fn api_delete_closed_sessions(
    db: Data<SharedDatabaseConnection>,
    recordings: Data<Arc<Mutex<SessionRecordings>>>,
    _sec_scheme: AnySecurityScheme,
    auth: Data<RequestAuthorization>,
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

pub async fn api_get_sessions_changes_stream(
    ws: WebSocketUpgrade,
    state: Data<Arc<RwLock<State>>>,
) -> Response {
    let mut receiver = state.write().await.subscribe();

    ws.on_upgrade(|socket| async move {
        let (mut sink, _) = socket.split();

        while receiver.recv().await.is_ok() {
            if sink.send(Message::Text("".into())).await.is_err() {
                break;
            }
        }
    })
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_all_sessions,
        api_close_all_sessions,
        api_delete_closed_sessions,
    )
}
