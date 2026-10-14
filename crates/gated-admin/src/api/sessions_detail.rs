use axum::extract::Path;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use std::sync::Arc;
use utoipa_axum::router::OpenApiRouter;

use gated_common::GatedError;
use gated_core::SharedDatabaseConnection;
use gated_core::recordings::SessionRecordings;
use gated_core::{SessionSnapshot, State};
use gated_db_entities::{LogEntry, Recording, Session};
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder,
};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use super::AnySecurityScheme;
use crate::http_service::common::RequestAuthorization;

api_response! {
    #[allow(clippy::large_enum_variant)]
    enum GetSessionResponse {
        #[oai(status = 200)]
        Ok(Json<SessionSnapshot>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum GetSessionRecordingsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<Recording::Model>>),
    }
}

api_response! {
    enum CloseSessionResponse {
        #[oai(status = 201)]
        Ok,
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum DeleteSessionResponse {
        #[oai(status = 200)]
        Ok,
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum TerminateSessionResponse {
        #[oai(status = 201)]
        Ok,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(get, path = "/sessions/{id}", operation_id = "get_session")]
async fn api_get_session(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSessionResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let session = Session::Entity::find_by_id(id.0).one(&db).await?;

    match session {
        Some(session) => Ok(GetSessionResponse::Ok(Json(session.into()))),
        None => Ok(GetSessionResponse::NotFound),
    }
}

#[utoipa::path(
    get,
    path = "/sessions/{id}/recordings",
    operation_id = "get_session_recordings"
)]
async fn api_get_session_recordings(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSessionRecordingsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let recordings: Vec<Recording::Model> = Recording::Entity::find()
        .order_by_desc(Recording::Column::Started)
        .filter(Recording::Column::SessionId.eq(id.0))
        .all(&db)
        .await?;
    Ok(GetSessionRecordingsResponse::Ok(Json(recordings)))
}

/// Gracefully close a live session: signal its handle so the owning
/// protocol loop tears the session down and removes it from the registry
/// itself. Admin-only — the entire `/admin/api` nest is wrapped with
/// `endpoint_admin_auth` (see `http_service::mod`), so a non-admin caller is
/// rejected with 403 before reaching this handler.
#[utoipa::path(post, path = "/sessions/{id}/close", operation_id = "close_session")]
async fn api_close_session(
    id: Path<Uuid>,
    state: Data<Arc<RwLock<State>>>,
    _sec_scheme: AnySecurityScheme,
) -> Result<CloseSessionResponse, GatedError> {
    let state = state.write().await;

    if let Some(s) = state.sessions.get(&id) {
        let mut session = s.lock().await;
        session.handle.close();
        Ok(CloseSessionResponse::Ok)
    } else {
        Ok(CloseSessionResponse::NotFound)
    }
}

/// Forcibly terminate a live session. Unlike graceful `close`, which only
/// signals the handle and waits for the protocol loop to self-remove, this
/// signals the handle **and** immediately evicts the session from the live
/// registry (marking it ended in the DB), so a wedged protocol loop cannot
/// keep the session alive. Admin-only via the `/admin/api` nest gate.
#[utoipa::path(
    post,
    path = "/sessions/{id}/terminate",
    operation_id = "terminate_session"
)]
async fn api_terminate_session(
    id: Path<Uuid>,
    state: Data<Arc<RwLock<State>>>,
    _sec_scheme: AnySecurityScheme,
) -> Result<TerminateSessionResponse, GatedError> {
    let mut state = state.write().await;

    let Some(s) = state.sessions.get(&id).cloned() else {
        return Ok(TerminateSessionResponse::NotFound);
    };
    s.lock().await.handle.close();
    state.remove_session(*id).await;
    Ok(TerminateSessionResponse::Ok)
}

/// Delete a session record and everything attached to it: its recording
/// files and rows, its log rows, and the session row. A still-live session
/// is closed first so no writer keeps a file open. Admin-only via the
/// `/admin/api` nest gate (`endpoint_admin_auth`).
#[utoipa::path(delete, path = "/sessions/{id}", operation_id = "delete_session")]
async fn api_delete_session(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    state: Data<Arc<RwLock<State>>>,
    recordings: Data<Arc<Mutex<SessionRecordings>>>,
    _sec_scheme: AnySecurityScheme,
    auth: Data<RequestAuthorization>,
) -> Result<DeleteSessionResponse, GatedError> {
    {
        let state = state.write().await;
        if let Some(s) = state.sessions.get(&id) {
            s.lock().await.handle.close();
        }
    }

    let db = gated_core::db_required(&db).await?;
    if Session::Entity::find_by_id(id.0).one(&db).await?.is_none() {
        return Ok(DeleteSessionResponse::NotFound);
    }

    let recs = Recording::Entity::find()
        .filter(Recording::Column::SessionId.eq(id.0))
        .all(&db)
        .await?;

    // Record a durable audit trail BEFORE destroying anything, so an
    // insider admin cannot wipe a session without leaving evidence and the
    // record survives even if the destruction below partially fails.
    let log_count = LogEntry::Entity::find()
        .filter(LogEntry::Column::SessionId.eq(id.0))
        .count(&db)
        .await?;
    write_session_delete_audit(
        &db,
        &[id.0],
        recs.len() as u64,
        log_count,
        1,
        auth.username().map(String::as_str).unwrap_or("admin-token"),
    )
    .await?;
    {
        let recordings = recordings.lock().await;
        for r in &recs {
            // File may already be gone (recording disabled / never written).
            let _ = recordings.remove(&id.0, &r.name).await;
        }
    }
    Recording::Entity::delete_many()
        .filter(Recording::Column::SessionId.eq(id.0))
        .exec(&db)
        .await?;
    LogEntry::Entity::delete_many()
        .filter(LogEntry::Column::SessionId.eq(id.0))
        .exec(&db)
        .await?;
    Session::Entity::delete_by_id(id.0).exec(&db).await?;

    Ok(DeleteSessionResponse::Ok)
}

/// Sentinel session id under which audit-of-deletion records are stored. The
/// session-deletion endpoints only ever delete log rows whose `session_id`
/// matches a real session being destroyed, so storing the audit record under
/// the nil session id keeps it out of reach of the very deletion it documents
/// (it can never be self-erased). This matches the existing reveal-audit
/// convention in `accounts.rs`.
const AUDIT_SESSION_ID: Uuid = Uuid::nil();

/// Write a durable audit record for an administrative session
/// deletion. Must be called BEFORE any data is destroyed so the trail survives
/// even a partially-failing delete. The record is stored under
/// [`AUDIT_SESSION_ID`] so the deletion cannot remove it.
pub(super) async fn write_session_delete_audit(
    db: &impl ConnectionTrait,
    session_ids: &[Uuid],
    recordings_deleted: u64,
    log_entries_deleted: u64,
    sessions_deleted: u64,
    actor: &str,
) -> Result<(), GatedError> {
    let values = serde_json::json!({
        "event": "session.delete",
        "actor": actor,
        "session_ids": session_ids.iter().map(Uuid::to_string).collect::<Vec<_>>(),
        "recordings_deleted": recordings_deleted,
        "log_entries_deleted": log_entries_deleted,
        "sessions_deleted": sessions_deleted,
    });

    let entry = gated_db_entities::ManagementAudit::ActiveModel {
        id: Set(Uuid::new_v4()),
        text: Set("Admin deleted session(s) and attached recordings/logs".into()),
        values: Set(values),
        timestamp: Set(chrono::Utc::now()),
        session_id: Set(AUDIT_SESSION_ID),
        username: Set(Some(actor.to_string())),
    };
    entry.insert(db).await?;
    Ok(())
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_session,
        api_get_session_recordings,
        api_close_session,
        api_terminate_session,
        api_delete_session,
    )
}

#[cfg(test)]
mod tests {
    use sea_orm::{Database, DatabaseConnection, DbBackend, Statement};

    use super::*;

    async fn setup_log_db() -> DatabaseConnection {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            r#"CREATE TABLE log (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                "values" TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                session_id TEXT NOT NULL,
                username TEXT
            )"#,
        ))
        .await
        .expect("create log table");
        conn.execute_unprepared("CREATE TABLE management_audit AS SELECT * FROM log WHERE 0")
            .await
            .expect("create management audit");
        conn
    }

    /// The deletion audit record must be written and must survive the very
    /// session-scoped log purge that the deletion endpoints perform, proving it
    /// cannot be erased by the same endpoint.
    #[tokio::test]
    async fn delete_audit_written_and_survives_session_log_purge() {
        let db = setup_log_db().await;
        let session_id = Uuid::new_v4();

        // A normal session-scoped log row that the deletion would remove.
        LogEntry::ActiveModel {
            id: Set(Uuid::new_v4()),
            text: Set("session activity".into()),
            values: Set(serde_json::json!({})),
            timestamp: Set(chrono::Utc::now()),
            session_id: Set(session_id),
            username: Set(Some("u".into())),
        }
        .insert(&db)
        .await
        .expect("insert session log");

        // Audit written BEFORE destruction.
        write_session_delete_audit(&db, &[session_id], 2, 5, 1, "operator-a")
            .await
            .expect("write audit");

        // Mirror the endpoint's log deletion (filtered by the affected session).
        LogEntry::Entity::delete_many()
            .filter(LogEntry::Column::SessionId.eq(session_id))
            .exec(&db)
            .await
            .expect("delete session logs");

        let remaining = gated_db_entities::ManagementAudit::Entity::find()
            .all(&db)
            .await
            .expect("find remaining logs");
        assert_eq!(remaining.len(), 1, "only the audit record should remain");
        let audit = &remaining[0];
        assert_eq!(audit.session_id, AUDIT_SESSION_ID);
        assert_eq!(audit.username.as_deref(), Some("operator-a"));
        assert_eq!(audit.values["event"], "session.delete");
        assert_eq!(audit.values["actor"], "operator-a");
        assert_eq!(audit.values["recordings_deleted"], 2);
        assert_eq!(audit.values["log_entries_deleted"], 5);
        assert_eq!(audit.values["sessions_deleted"], 1);
        assert_eq!(audit.values["session_ids"][0], session_id.to_string());
    }
}
