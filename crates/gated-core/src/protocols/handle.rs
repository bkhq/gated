use std::sync::Arc;

use gated_common::auth::AuthStateUserInfo;
use gated_common::{GatedError, SessionId, Target};
use gated_db_entities::Session;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, RwLock};

use crate::rate_limiting::{RateLimiterRegistry, stack_rate_limiters};
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
            // Held across the write so concurrent calls insert the row once.
            let mut state = self.session_state.lock().await;
            state.user_info = Some(user_info.clone());
            let db = crate::db_required(&self.db).await?;
            if state.persisted {
                Session::Entity::update_many()
                    .set(Session::ActiveModel {
                        username: Set(Some(user_info.username)),
                        ..Default::default()
                    })
                    .filter(Session::Column::Id.eq(self.id))
                    .exec(&db)
                    .await?;
            } else {
                Session::ActiveModel {
                    id: Set(self.id),
                    started: Set(state.started),
                    remote_address: Set(state
                        .remote_address
                        .map(|x| x.to_string())
                        .unwrap_or_default()),
                    protocol: Set(state.protocol.to_string()),
                    username: Set(Some(user_info.username)),
                    target_snapshot: Set(target_snapshot(state.target.as_ref())?),
                    ..Default::default()
                }
                .insert(&db)
                .await?;
                state.persisted = true;
            }
            state.emit_change()
        }

        self.update_rate_limiters().await?;

        Ok(())
    }

    pub async fn set_target(&self, target: &Target) -> Result<(), GatedError> {
        use sea_orm::ActiveValue::Set;
        {
            let mut state = self.session_state.lock().await;
            state.target = Some(target.clone());
            // Before authentication the target is written with the row.
            if state.persisted {
                let db = crate::db_required(&self.db).await?;
                Session::Entity::update_many()
                    .set(Session::ActiveModel {
                        target_snapshot: Set(target_snapshot(Some(target))?),
                        ..Default::default()
                    })
                    .filter(Session::Column::Id.eq(self.id))
                    .exec(&db)
                    .await?;
            }
            state.emit_change()
        }

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

    pub async fn wrap_stream<S: AsyncRead + AsyncWrite + Unpin + Send>(
        &mut self,
        stream: S,
    ) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send + use<S>, GatedError> {
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

fn target_snapshot(target: Option<&Target>) -> Result<Option<String>, GatedError> {
    target
        .map(|target| serde_json::to_string(target).map_err(GatedError::other))
        .transpose()
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
