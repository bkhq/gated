use std::any::type_name;
use std::sync::Arc;

use crate::http_service::session::SessionStore;
use gated_common::auth::AuthStateUserInfo;
use gated_common::{GatedError, SessionId};
use poem::error::GetDataError;
use poem::session::Session;
use poem::web::Data;
use poem::{FromRequest, Request, RequestBody};
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

impl<'a> FromRequest<'a> for ManagementSessionFromRequest {
    async fn from_request(req: &'a Request, _: &mut RequestBody) -> poem::Result<Self> {
        let sm = Data::<&Arc<Mutex<SessionStore>>>::from_request_without_body(req).await?;
        let session = <&Session>::from_request_without_body(req).await?;
        sm.lock()
            .await
            .handle_for(session)
            .map(Self)
            .ok_or_else(|| GetDataError(type_name::<ManagementSessionHandle>()).into())
    }
}

impl From<Arc<Mutex<ManagementSessionHandle>>> for ManagementSessionFromRequest {
    fn from(handle: Arc<Mutex<ManagementSessionHandle>>) -> Self {
        Self(handle)
    }
}
