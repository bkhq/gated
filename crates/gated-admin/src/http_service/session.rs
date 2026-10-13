use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gated_common::SessionId;
use poem::session::{MemoryStorage, Session, SessionStorage};
use poem::{FromRequest, Request};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::*;

use crate::http_service::session_handle::{ManagementSessionFromRequest, ManagementSessionHandle};

#[derive(Clone)]
pub struct SharedSessionStorage(pub Arc<Mutex<Box<MemoryStorage>>>);

static POEM_SESSION_ID_SESSION_KEY: &str = "poem_session_id";

impl SessionStorage for SharedSessionStorage {
    async fn load_session<'a>(
        &'a self,
        session_id: &'a str,
    ) -> poem::Result<Option<BTreeMap<String, Value>>> {
        self.0.lock().await.load_session(session_id).await.map(|o| {
            o.map(|mut s| {
                s.insert(
                    POEM_SESSION_ID_SESSION_KEY.to_string(),
                    session_id.to_string().into(),
                );
                s
            })
        })
    }

    /// Insert or update a session.
    async fn update_session<'a>(
        &'a self,
        session_id: &'a str,
        entries: &'a BTreeMap<String, Value>,
        expires: Option<Duration>,
    ) -> poem::Result<()> {
        self.0
            .lock()
            .await
            .update_session(session_id, entries, expires)
            .await
    }

    /// Remove a session by session id.
    async fn remove_session<'a>(&'a self, session_id: &'a str) -> poem::Result<()> {
        self.0.lock().await.remove_session(session_id).await
    }
}

pub struct ManagementSessionSummary {
    pub id: SessionId,
    pub username: String,
    pub created: chrono::DateTime<chrono::Utc>,
    pub last_active: chrono::DateTime<chrono::Utc>,
}

pub struct SessionStore {
    session_handles: HashMap<SessionId, Arc<Mutex<ManagementSessionHandle>>>,
    session_timestamps: HashMap<SessionId, Instant>,
}

static SESSION_ID_SESSION_KEY: &str = "session_id";

impl SessionStore {
    pub fn new() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            session_handles: HashMap::new(),
            session_timestamps: HashMap::new(),
        }))
    }

    pub async fn process_request(&mut self, req: Request) -> poem::Result<Request> {
        let session = <&Session>::from_request_without_body(&req).await?;

        if let Some(session_id) = session.get::<SessionId>(SESSION_ID_SESSION_KEY) {
            if self.session_handles.contains_key(&session_id) {
                self.session_timestamps.insert(session_id, Instant::now());
            } else {
                // The server-side handle is gone (revoked by a password
                // change or expired by the idle vacuum), so the cookie must
                // stop authenticating.
                info!(%session_id, "Session handle is gone, purging HTTP session");
                session.purge();
            }
        };

        Ok(req)
    }

    pub async fn create_handle_for(
        &mut self,
        req: &Request,
    ) -> poem::Result<ManagementSessionFromRequest> {
        let session = <&Session>::from_request_without_body(req).await?;

        if let Some(handle) = self.handle_for(session) {
            return Ok(handle.into());
        }

        let id = uuid::Uuid::new_v4();
        let server_handle = Arc::new(Mutex::new(ManagementSessionHandle {
            id,
            user_info: None,
            created: chrono::Utc::now(),
        }));
        self.session_handles.insert(id, server_handle.clone());
        session.set(SESSION_ID_SESSION_KEY, id);
        self.session_timestamps.insert(id, Instant::now());

        Ok(server_handle.into())
    }

    pub fn handle_for(&self, session: &Session) -> Option<Arc<Mutex<ManagementSessionHandle>>> {
        session
            .get::<SessionId>(SESSION_ID_SESSION_KEY)
            .and_then(|id| self.session_handles.get(&id).cloned())
    }

    pub fn remove_session(&mut self, session: &Session) {
        if let Some(id) = session.get::<SessionId>(SESSION_ID_SESSION_KEY) {
            self.session_handles.remove(&id);
            self.session_timestamps.remove(&id);
        }
    }

    pub async fn revoke_other_sessions(
        &mut self,
        username: &str,
        keep: Option<SessionId>,
    ) -> usize {
        let mut ids = Vec::new();
        for (id, handle) in &self.session_handles {
            if Some(*id) != keep
                && handle
                    .lock()
                    .await
                    .user_info
                    .as_ref()
                    .is_some_and(|user| user.username == username)
            {
                ids.push(*id);
            }
        }
        for id in &ids {
            self.session_handles.remove(id);
            self.session_timestamps.remove(id);
        }
        ids.len()
    }

    /// Snapshot of live authenticated browser sessions, oldest first.
    pub async fn list(&self) -> Vec<ManagementSessionSummary> {
        let now = Instant::now();
        let now_utc = chrono::Utc::now();
        let mut sessions = Vec::new();
        for (id, handle) in &self.session_handles {
            let handle = handle.lock().await;
            let Some(user_info) = handle.user_info.as_ref() else {
                continue;
            };
            let idle = self
                .session_timestamps
                .get(id)
                .map(|at| now.duration_since(*at))
                .unwrap_or_default();
            sessions.push(ManagementSessionSummary {
                id: *id,
                username: user_info.username.clone(),
                created: handle.created,
                last_active: now_utc - chrono::Duration::from_std(idle).unwrap_or_default(),
            });
        }
        sessions.sort_by_key(|session| session.created);
        sessions
    }

    /// Revoke one browser session. Its cookie stops authenticating on the
    /// next request. Returns `false` when no such session exists.
    pub fn revoke(&mut self, id: SessionId) -> bool {
        self.session_timestamps.remove(&id);
        self.session_handles.remove(&id).is_some()
    }

    pub async fn vacuum(&mut self, session_max_age: Duration) {
        let now = Instant::now();
        let mut to_remove = vec![];
        for (id, timestamp) in self.session_timestamps.iter() {
            if now.duration_since(*timestamp) > session_max_age {
                to_remove.push(*id);
            }
        }
        for id in to_remove {
            self.session_handles.remove(&id);
            self.session_timestamps.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gated_common::auth::AuthStateUserInfo;
    use uuid::Uuid;

    async fn add(store: &mut SessionStore, username: &str, at: Instant) -> SessionId {
        let id = Uuid::new_v4();
        store.session_handles.insert(
            id,
            Arc::new(Mutex::new(ManagementSessionHandle {
                id,
                user_info: Some(AuthStateUserInfo {
                    id: Uuid::new_v4(),
                    username: username.into(),
                }),
                created: chrono::Utc::now(),
            })),
        );
        store.session_timestamps.insert(id, at);
        id
    }

    #[tokio::test]
    async fn revokes_only_other_management_sessions_and_expires_idle_sessions() {
        let store = SessionStore::new();
        let mut store = store.lock().await;
        let now = Instant::now();
        let keep = add(&mut store, "alice", now).await;
        let other = add(&mut store, "alice", now).await;
        let bob = add(&mut store, "bob", now - Duration::from_secs(120)).await;
        assert_eq!(store.revoke_other_sessions("alice", Some(keep)).await, 1);
        assert!(store.session_handles.contains_key(&keep));
        assert!(!store.session_handles.contains_key(&other));
        assert!(store.session_handles.contains_key(&bob));
        store.vacuum(Duration::from_secs(60)).await;
        assert!(store.session_handles.contains_key(&keep));
        assert!(!store.session_handles.contains_key(&bob));
    }

    #[tokio::test]
    async fn lists_authenticated_sessions_and_revokes_by_id() {
        let store = SessionStore::new();
        let mut store = store.lock().await;
        let now = Instant::now();
        let alice = add(&mut store, "alice", now).await;
        let anonymous = Uuid::new_v4();
        store.session_handles.insert(
            anonymous,
            Arc::new(Mutex::new(ManagementSessionHandle {
                id: anonymous,
                user_info: None,
                created: chrono::Utc::now(),
            })),
        );
        let listed = store.list().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, alice);
        assert_eq!(listed[0].username, "alice");
        assert!(store.revoke(alice));
        assert!(!store.revoke(alice));
        assert!(store.list().await.is_empty());
    }
}
