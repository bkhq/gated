//! Admin view of authenticated browser (management) sessions.
//!
//! These live in the in-memory management registry, not in the proxy
//! `sessions` table. Revoking one makes its cookie stop authenticating on the
//! next request.
use std::sync::Arc;

use chrono::{DateTime, Utc};
use poem::session::Session;
use poem::web::Data;
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::AnySecurityScheme;
use crate::http_service::session::SessionStore;

pub struct Api;

#[derive(Object)]
struct ManagementSession {
    id: Uuid,
    username: String,
    created: DateTime<Utc>,
    last_active: DateTime<Utc>,
    /// Whether this is the caller's own browser session.
    current: bool,
}

#[derive(ApiResponse)]
enum ListResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<ManagementSession>>),
}

#[derive(ApiResponse)]
enum RevokeResponse {
    #[oai(status = 204)]
    Revoked,
    #[oai(status = 404)]
    NotFound,
}

#[OpenApi]
impl Api {
    #[oai(
        path = "/management-sessions",
        method = "get",
        operation_id = "get_management_sessions"
    )]
    async fn api_get_management_sessions(
        &self,
        store: Data<&Arc<Mutex<SessionStore>>>,
        session: &Session,
        _sec_scheme: AnySecurityScheme,
    ) -> ListResponse {
        let store = store.lock().await;
        let current = match store.handle_for(session) {
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

    #[oai(
        path = "/management-sessions/:id",
        method = "delete",
        operation_id = "revoke_management_session"
    )]
    async fn api_revoke_management_session(
        &self,
        store: Data<&Arc<Mutex<SessionStore>>>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> RevokeResponse {
        if store.lock().await.revoke(id.0) {
            RevokeResponse::Revoked
        } else {
            RevokeResponse::NotFound
        }
    }
}
