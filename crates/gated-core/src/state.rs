use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use gated_common::auth::AuthStateUserInfo;
use gated_common::{GatedError, ProtocolName, SessionId, Target};
use gated_db_entities::Session;
use sea_orm::{ActiveModelTrait, EntityTrait};
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing::*;
use uuid::Uuid;

use crate::rate_limiting::{RateLimiterRegistry, RateLimiterStackHandle};
use crate::{GatedServerHandle, SessionHandle, SharedDatabaseConnection};

pub struct State {
    pub sessions: HashMap<SessionId, Arc<Mutex<SessionState>>>,
    db: SharedDatabaseConnection,
    rate_limiter_registry: Arc<Mutex<RateLimiterRegistry>>,
    change_sender: broadcast::Sender<()>,
}

impl State {
    pub fn new(
        db: &SharedDatabaseConnection,
        rate_limiter_registry: &Arc<Mutex<RateLimiterRegistry>>,
    ) -> Result<Arc<RwLock<Self>>, GatedError> {
        let sender = broadcast::channel(2).0;
        Ok(Arc::new(RwLock::new(Self {
            sessions: HashMap::new(),
            db: db.clone(),
            rate_limiter_registry: rate_limiter_registry.clone(),
            change_sender: sender,
        })))
    }

    pub async fn register_session(
        this: &Arc<RwLock<Self>>,
        protocol: &ProtocolName,
        state: SessionStateInit,
    ) -> Result<Arc<Mutex<GatedServerHandle>>, GatedError> {
        let this_copy = this.clone();
        let mut _self = this.write().await;
        let id = uuid::Uuid::new_v4();

        let state = Arc::new(Mutex::new(SessionState::new(
            state,
            _self.change_sender.clone(),
            protocol,
        )));

        _self.sessions.insert(id, state.clone());

        metrics::gauge!(
            "gated_sessions_active",
            "protocol" => *protocol,
        )
        .increment(1.0);

        {
            use sea_orm::ActiveValue::Set;

            let values = Session::ActiveModel {
                id: Set(id),
                started: Set(chrono::Utc::now()),
                remote_address: Set(state
                    .lock()
                    .await
                    .remote_address
                    .map(|x| x.to_string())
                    .unwrap_or_else(|| "".to_string())),
                protocol: Set(protocol.to_string()),
                ..Default::default()
            };

            let db = crate::db_required(&_self.db).await?;
            values
                .insert(&db)
                .await
                .context("Error inserting session")
                .map_err(GatedError::from)?;
        }

        let _ = _self.change_sender.send(());

        Ok(Arc::new(Mutex::new(GatedServerHandle::new(
            id,
            _self.db.clone(),
            this_copy,
            state,
            _self.rate_limiter_registry.clone(),
        )?)))
    }

    pub fn subscribe(&mut self) -> broadcast::Receiver<()> {
        self.change_sender.subscribe()
    }

    /// Asks every session to close and waits up to `timeout` for them to
    /// deregister. Returns the number of sessions still registered.
    pub async fn close_all_sessions(this: &Arc<RwLock<Self>>, timeout: Duration) -> usize {
        let mut changes = this.write().await.subscribe();
        let sessions: Vec<_> = this.read().await.sessions.values().cloned().collect();
        for session in sessions {
            session.lock().await.handle.close();
        }

        let _ = tokio::time::timeout(timeout, async {
            while !this.read().await.sessions.is_empty() {
                if let Err(broadcast::error::RecvError::Closed) = changes.recv().await {
                    break;
                }
            }
        })
        .await;

        this.read().await.sessions.len()
    }

    pub async fn remove_session(&mut self, id: SessionId) {
        if let Some(state) = self.sessions.remove(&id) {
            let protocol = state.lock().await.protocol;
            metrics::gauge!(
                "gated_sessions_active",
                "protocol" => protocol,
            )
            .decrement(1.0);
        }

        if let Err(error) = self.mark_session_complete(id).await {
            error!(%error, %id, "Could not update session in the DB");
        }

        let _ = self.change_sender.send(());
    }

    async fn mark_session_complete(&mut self, id: Uuid) -> Result<()> {
        use sea_orm::ActiveValue::Set;
        let db = crate::db_required(&self.db).await?;
        let session = Session::Entity::find_by_id(id)
            .one(&db)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;
        let mut model: Session::ActiveModel = session.into();
        model.ended = Set(Some(chrono::Utc::now()));
        model.update(&db).await?;
        Ok(())
    }
}

pub struct SessionState {
    pub remote_address: Option<SocketAddr>,
    pub user_info: Option<AuthStateUserInfo>,
    pub target: Option<Target>,
    pub handle: Box<dyn SessionHandle + Send + Sync>,
    change_sender: broadcast::Sender<()>,
    pub rate_limiter_handles: Vec<RateLimiterStackHandle>,
    /// Protocol name stashed at registration so `remove_session` can
    /// decrement the matching gauge label without hitting the DB.
    /// `ProtocolName` is `&'static str`, so this is a pointer copy, not
    /// a new allocation.
    pub(crate) protocol: ProtocolName,
    pub(crate) connected_targets: HashSet<Uuid>,
}

pub struct SessionStateInit {
    pub remote_address: Option<SocketAddr>,
    pub handle: Box<dyn SessionHandle + Send + Sync>,
}

impl SessionState {
    pub(crate) fn new(
        init: SessionStateInit,
        change_sender: broadcast::Sender<()>,
        protocol: ProtocolName,
    ) -> Self {
        SessionState {
            remote_address: init.remote_address,
            user_info: None,
            target: None,
            handle: init.handle,
            change_sender,
            rate_limiter_handles: vec![],
            protocol,
            connected_targets: HashSet::new(),
        }
    }

    pub fn emit_change(&self) {
        let _ = self.change_sender.send(());
    }
}
