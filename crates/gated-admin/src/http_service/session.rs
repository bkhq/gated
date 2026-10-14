use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex as StdMutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::{COOKIE, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use cookie::Cookie;
use gated_common::SessionId;
use gated_common::helpers::rng::get_crypto_rng;
use gated_common::web::ApiArgument;
use rand::Rng;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::*;

use crate::http_service::session_handle::{ManagementSessionFromRequest, ManagementSessionHandle};

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum SessionStatus {
    Changed,
    Purged,
    Unchanged,
}

struct SessionInner {
    status: SessionStatus,
    entries: BTreeMap<String, Value>,
}

/// Server-side key/value state of one browser session. Changes are persisted
/// and the cookie is issued once the request completes.
#[derive(Clone)]
pub struct Session {
    inner: Arc<RwLock<SessionInner>>,
}

impl Session {
    fn new(entries: BTreeMap<String, Value>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(SessionInner {
                status: SessionStatus::Unchanged,
                entries,
            })),
        }
    }

    fn update(&self, change: impl FnOnce(&mut BTreeMap<String, Value>)) {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        if inner.status != SessionStatus::Purged {
            change(&mut inner.entries);
            inner.status = SessionStatus::Changed;
        }
    }

    pub fn get<T: DeserializeOwned>(&self, name: &str) -> Option<T> {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        inner
            .entries
            .get(name)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
    }

    pub fn set(&self, name: &str, value: impl Serialize) {
        if let Ok(value) = serde_json::to_value(&value) {
            self.update(|entries| {
                entries.insert(name.to_owned(), value);
            });
        }
    }

    pub fn remove(&self, name: &str) {
        self.update(|entries| {
            entries.remove(name);
        });
    }

    pub fn clear(&self) {
        self.update(BTreeMap::clear);
    }

    /// Drops the session together with its cookie.
    pub fn purge(&self) {
        let mut inner = self.inner.write().unwrap_or_else(PoisonError::into_inner);
        inner.entries.clear();
        inner.status = SessionStatus::Purged;
    }

    fn snapshot(&self) -> (SessionStatus, BTreeMap<String, Value>) {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        (inner.status, inner.entries.clone())
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Session {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts.extensions.get::<Session>().cloned().ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "session layer is not installed",
        ))
    }
}

impl ApiArgument for Session {}

struct StoredSession {
    entries: BTreeMap<String, Value>,
    expires_at: Instant,
}

/// In-memory session storage keyed by the random identifier carried in the
/// session cookie.
#[derive(Clone)]
pub struct SessionLayer {
    cookie_name: &'static str,
    secure: bool,
    max_age: Duration,
    sessions: Arc<StdMutex<HashMap<String, StoredSession>>>,
}

/// Session identifier following the OWASP entropy recommendation.
fn generate_session_id() -> String {
    data_encoding::BASE64URL_NOPAD.encode(&get_crypto_rng().r#gen::<[u8; 32]>())
}

impl SessionLayer {
    pub fn new(cookie_name: &'static str, secure: bool, max_age: Duration) -> Self {
        Self {
            cookie_name,
            secure,
            max_age,
            sessions: Arc::default(),
        }
    }

    fn load(&self, id: &str) -> Option<BTreeMap<String, Value>> {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        match sessions.get(id) {
            Some(session) if session.expires_at > Instant::now() => Some(session.entries.clone()),
            Some(_) => {
                sessions.remove(id);
                None
            }
            None => None,
        }
    }

    fn store(&self, id: &str, entries: BTreeMap<String, Value>) {
        let session = StoredSession {
            entries,
            expires_at: Instant::now() + self.max_age,
        };
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_owned(), session);
    }

    fn remove(&self, id: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }

    /// Drops every expired session.
    pub fn vacuum(&self) {
        let now = Instant::now();
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|_, session| session.expires_at > now);
    }

    fn cookie(&self, value: String) -> Cookie<'static> {
        let mut cookie = Cookie::new(self.cookie_name, value);
        cookie.set_path("/");
        cookie.set_secure(self.secure);
        cookie.set_http_only(true);
        cookie
    }

    fn session_id(&self, request: &Request) -> Option<String> {
        request
            .headers()
            .get_all(COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(Cookie::split_parse)
            .filter_map(Result::ok)
            .find(|cookie| cookie.name() == self.cookie_name)
            .map(|cookie| cookie.value().to_owned())
    }
}

/// Loads the session named by the request cookie, exposes it as a request
/// extension and persists what the request changed.
pub async fn session_middleware(
    State(layer): State<SessionLayer>,
    mut request: Request,
    next: Next,
) -> Response {
    let mut session_id = layer.session_id(&request);
    let session = match session_id.as_deref().and_then(|id| layer.load(id)) {
        Some(entries) => Session::new(entries),
        None => {
            session_id = None;
            Session::new(BTreeMap::new())
        }
    };
    request.extensions_mut().insert(session.clone());

    let mut response = next.run(request).await;

    let cookie = match (session.snapshot(), session_id) {
        ((SessionStatus::Changed, entries), Some(id)) => {
            layer.store(&id, entries);
            None
        }
        ((SessionStatus::Changed, entries), None) => {
            let id = generate_session_id();
            layer.store(&id, entries);
            let mut cookie = layer.cookie(id);
            cookie.set_max_age(cookie::time::Duration::try_from(layer.max_age).ok());
            Some(cookie)
        }
        ((SessionStatus::Purged, _), Some(id)) => {
            layer.remove(&id);
            let mut cookie = layer.cookie(String::new());
            cookie.make_removal();
            Some(cookie)
        }
        _ => None,
    };
    if let Some(cookie) = cookie
        && let Ok(value) = HeaderValue::from_str(&cookie.to_string())
    {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
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

    /// Records activity on the session, or drops its cookie when the
    /// server-side handle no longer exists.
    pub fn touch(&mut self, session: &Session) {
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
    }

    pub fn create_handle_for(&mut self, session: &Session) -> ManagementSessionFromRequest {
        if let Some(handle) = self.handle_for(session) {
            return handle.into();
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

        server_handle.into()
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
