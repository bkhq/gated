use std::sync::Arc;

use gated_common::auth::AuthStateUserInfo;
use gated_common::{GatedError, SessionId, Target};
use gated_db_entities::Session;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, RwLock};

use crate::rate_limiting::{stack_rate_limiters, RateLimiterRegistry};
use crate::{SessionState, SharedDatabaseConnection, State};

pub trait SessionHandle {
    fn close(&mut self);
}

#[derive(Clone)]
pub struct GatedServerHandle {
    id: SessionId,
    db: SharedDatabaseConnection,
    state: Arc<RwLock<State>>,
    session_state: Arc<Mutex<SessionState>>,
    rate_limiters_registry: Arc<Mutex<RateLimiterRegistry>>,
}

impl GatedServerHandle {
    pub fn new(
        id: SessionId,
        db: SharedDatabaseConnection,
        state: Arc<RwLock<State>>,
        session_state: Arc<Mutex<SessionState>>,
        rate_limiters_registry: Arc<Mutex<RateLimiterRegistry>>,
    ) -> Result<Self, GatedError> {
        Ok(GatedServerHandle {
            id,
            db,
            state,
            session_state,
            rate_limiters_registry,
        })
    }

    pub fn id(&self) -> SessionId {
        self.id
    }

    pub fn session_state(&self) -> &Arc<Mutex<SessionState>> {
        &self.session_state
    }

    pub async fn set_user_info(&self, user_info: AuthStateUserInfo) -> Result<(), GatedError> {
        use sea_orm::ActiveValue::Set;

        {
            let mut state = self.session_state.lock().await;
            state.user_info = Some(user_info.clone());
            state.emit_change()
        }

        let db = crate::db_required(&self.db).await?;

        Session::Entity::update_many()
            .set(Session::ActiveModel {
                username: Set(Some(user_info.username)),
                ..Default::default()
            })
            .filter(Session::Column::Id.eq(self.id))
            .exec(&db)
            .await?;

        drop(db);

        self.update_rate_limiters().await?;

        Ok(())
    }

    pub async fn set_target(&self, target: &Target) -> Result<(), GatedError> {
        use sea_orm::ActiveValue::Set;
        {
            let mut state = self.session_state.lock().await;
            state.target = Some(target.clone());
            state.emit_change()
        }

        let db = crate::db_required(&self.db).await?;

        Session::Entity::update_many()
            .set(Session::ActiveModel {
                target_snapshot: Set(Some(
                    serde_json::to_string(&target).map_err(GatedError::other)?,
                )),
                ..Default::default()
            })
            .filter(Session::Column::Id.eq(self.id))
            .exec(&db)
            .await?;

        drop(db);

        self.update_rate_limiters().await?;

        Ok(())
    }

    /// Emit once after an upstream connection succeeds, never merely on target selection.
    pub async fn audit_target_connected(&self) {
        let mut state = self.session_state.lock().await;
        let Some(target) = state.target.clone() else {
            return;
        };
        if !state.connected_targets.insert(target.id) {
            return;
        }
        let username = state
            .user_info
            .as_ref()
            .map(|user| user.username.as_str())
            .unwrap_or("");
        crate::audit!(event = "target_connected", session = %self.id, session_username = username,
            username, target = %target.name, protocol = state.protocol,
            client_ip = %state.remote_address.map(|address| address.ip().to_string()).unwrap_or_default(),
            "Target connected");
    }

    pub async fn wrap_stream(
        &mut self,
        stream: impl AsyncRead + AsyncWrite + Unpin + Send,
    ) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send, GatedError> {
        let (stream, mut handle) = stack_rate_limiters(stream);
        let mut ss = self.session_state.lock().await;
        self.rate_limiters_registry
            .lock()
            .await
            .update_rate_limiters(&ss, &mut handle)
            .await?;
        ss.rate_limiter_handles.push(handle);
        Ok(stream)
    }

    async fn update_rate_limiters(&self) -> Result<(), GatedError> {
        let mut state = self.session_state.lock().await;
        let mut registry = self.rate_limiters_registry.lock().await;
        registry.update_all_rate_limiters(&mut state).await?;
        Ok(())
    }
}

impl Drop for GatedServerHandle {
    fn drop(&mut self) {
        let id = self.id;
        let state = self.state.clone();
        tokio::spawn(async move {
            state.write().await.remove_session(id).await;
        });
    }
}
