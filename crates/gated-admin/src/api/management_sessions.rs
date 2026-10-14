//! Admin view of authenticated browser (management) sessions.
//!
//! These live in the in-memory management registry, not in the proxy
//! `sessions` table. Revoking one makes its cookie stop authenticating on the
//! next request.
use crate::http_service::session::Session;
use axum::extract::Path;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use serde::Serialize;
use std::sync::Arc;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use chrono::{DateTime, Utc};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::AnySecurityScheme;
use crate::http_service::session::SessionStore;

#[derive(Serialize, ToSchema)]
struct ManagementSession {
    id: Uuid,
    username: String,
    created: DateTime<Utc>,
    last_active: DateTime<Utc>,
    /// Whether this is the caller's own browser session.
    current: bool,
}

api_response! {
    enum ListResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ManagementSession>>),
    }
}

api_response! {
    enum RevokeResponse {
        #[oai(status = 204)]
        Revoked,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    get,
    path = "/management-sessions",
    operation_id = "get_management_sessions"
)]
async fn api_get_management_sessions(
    store: Data<Arc<Mutex<SessionStore>>>,
    session: Session,
    _sec_scheme: AnySecurityScheme,
) -> ListResponse {
    let store = store.lock().await;
    let current = match store.handle_for(&session) {
        Some(handle) => Some(handle.lock().await.id()),
        None => None,
    };
    let sessions = store
        .list()
        .await
        .into_iter()
        .map(|summary| ManagementSession {
            current: Some(summary.id) == current,
            id: summary.id,
            username: summary.username,
            created: summary.created,
            last_active: summary.last_active,
        })
        .collect();
    ListResponse::Ok(Json(sessions))
}

#[utoipa::path(
    delete,
    path = "/management-sessions/{id}",
    operation_id = "revoke_management_session"
)]
async fn api_revoke_management_session(
    id: Path<Uuid>,
    store: Data<Arc<Mutex<SessionStore>>>,
    _sec_scheme: AnySecurityScheme,
) -> RevokeResponse {
    if store.lock().await.revoke(id.0) {
        RevokeResponse::Revoked
    } else {
        RevokeResponse::NotFound
    }
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_management_sessions, api_revoke_management_session,)
}
