use crate::http_service::session::Session;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use http::StatusCode;
use std::sync::Arc;

use crate::http_service::session::SessionStore;
use gated_common::auth::AuthStateUserInfo;
use gated_common::{GatedError, SessionId};
use tokio::sync::Mutex;

/// Browser authentication state has no proxy handle, recording or bandwidth limiter.
pub struct ManagementSessionHandle {
    pub id: SessionId,
    pub user_info: Option<AuthStateUserInfo>,
    pub created: chrono::DateTime<chrono::Utc>,
}

impl ManagementSessionHandle {
    pub fn id(&self) -> SessionId {
        self.id
    }

    pub async fn set_user_info(&mut self, user_info: AuthStateUserInfo) -> Result<(), GatedError> {
        self.user_info = Some(user_info);
        Ok(())
    }
}

#[derive(Clone)]
pub struct ManagementSessionFromRequest(pub Arc<Mutex<ManagementSessionHandle>>);

impl std::ops::Deref for ManagementSessionFromRequest {
    type Target = Arc<Mutex<ManagementSessionHandle>>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<S: Send + Sync> FromRequestParts<S> for ManagementSessionFromRequest {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let missing = (
            StatusCode::INTERNAL_SERVER_ERROR,
            "management session handle was not found",
        );
        let store = parts
            .extensions
            .get::<Arc<Mutex<SessionStore>>>()
            .ok_or(missing)?;
        let session = parts.extensions.get::<Session>().ok_or(missing)?;
        store
            .lock()
            .await
            .handle_for(session)
            .map(Self)
            .ok_or(missing)
    }
}

impl From<Arc<Mutex<ManagementSessionHandle>>> for ManagementSessionFromRequest {
    fn from(handle: Arc<Mutex<ManagementSessionHandle>>) -> Self {
        Self(handle)
    }
}
