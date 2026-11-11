use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex as StdMutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::{COOKIE, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use cookie::Cookie;
use gated_common::SessionId;
use gated_common::helpers::rng::get_crypto_rng;
use gated_common::web::ApiArgument;
use gated_core::Services;
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
    /// Move the session to a fresh identifier when the request completes.
    renew: bool,
    entries: BTreeMap<String, Value>,
}

/// Server-side key/value state of one browser session. Changes are persisted
/// and the cookie is issued once the request completes.
#[derive(Clone)]
pub struct Session {
    inner: Arc<RwLock<SessionInner>>,
}

impl Session {
    pub(crate) fn new(entries: BTreeMap<String, Value>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(SessionInner {
                status: SessionStatus::Unchanged,
                renew: false,
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

    /// Replaces the session identifier, so one known before sign-in cannot
    /// be used afterwards.
    pub fn renew(&self) {
        self.inner
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .renew = true;
    }

    fn snapshot(&self) -> (SessionStatus, bool, BTreeMap<String, Value>) {
        let inner = self.inner.read().unwrap_or_else(PoisonError::into_inner);
        (inner.status, inner.renew, inner.entries.clone())
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
    /// When the cookie `Max-Age` was last sent.
    cookie_sent: Instant,
}

/// How often the cookie of an active session is re-sent with a fresh `Max-Age`.
const COOKIE_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

/// Session lifetimes offered to users, besides the configured default.
const SESSION_LIFETIME_CHOICES: [Duration; 5] = [
    Duration::from_secs(30 * 60),
    Duration::from_secs(60 * 60),
    Duration::from_secs(4 * 60 * 60),
    Duration::from_secs(8 * 60 * 60),
    Duration::from_secs(24 * 60 * 60),
];

/// GET endpoints the web UI polls or refetches by itself (timers and push
/// notifications). Requests to them, or below them, do not count as user
/// activity, so a page left open cannot keep its session alive forever.
const BACKGROUND_PATHS: &[&str] = &[
    "/admin/api/sessions",
    "/admin/api/management-sessions",
    "/admin/api/command-reviews",
    "/admin/api/system/update",
    "/api/admin/encryption/lock-status",
    "/api/auth/state",
    "/api/auth/web-auth-requests",
    "/api/profile/sessions",
];

/// Whether a request extends the browser session it belongs to.
pub fn counts_as_activity(method: &Method, path: &str) -> bool {
    *method != Method::GET
        || !BACKGROUND_PATHS.iter().any(|background| {
            path.strip_prefix(background)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
}

/// The idle lifetimes a user may choose: the fixed choices up to `max`
/// plus the configured `default`, ascending.
pub fn session_lifetime_options(default: Duration, max: Duration) -> Vec<Duration> {
    let mut options: Vec<_> = SESSION_LIFETIME_CHOICES
        .into_iter()
        .filter(|choice| *choice <= max)
        .chain([default])
        .collect();
    options.sort();
    options.dedup();
    options
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
        let now = Instant::now();
        match sessions.get_mut(id) {
            Some(session) if session.expires_at > now => {
                session.expires_at = now + self.max_age;
                Some(session.entries.clone())
            }
            Some(_) => {
                sessions.remove(id);
                None
            }
            None => None,
        }
    }

    fn store(&self, id: &str, entries: BTreeMap<String, Value>) {
        let now = Instant::now();
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        let cookie_sent = sessions.get(id).map_or(now, |session| session.cookie_sent);
        sessions.insert(
            id.to_owned(),
            StoredSession {
                entries,
                expires_at: now + self.max_age,
                cookie_sent,
            },
        );
    }

    /// Whether the cookie of a live session is due to have its `Max-Age`
    /// re-sent, so the browser keeps it as long as the session slides.
    fn cookie_refresh_due(&self, id: &str) -> bool {
        let now = Instant::now();
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        match sessions.get_mut(id) {
            Some(session) if now.duration_since(session.cookie_sent) >= COOKIE_REFRESH_INTERVAL => {
                session.cookie_sent = now;
                true
            }
            _ => false,
        }
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

    fn refreshed_cookie(&self, id: String) -> Option<Cookie<'static>> {
        if !self.cookie_refresh_due(&id) {
            return None;
        }
        let mut cookie = self.cookie(id);
        cookie.set_max_age(cookie::time::Duration::try_from(self.max_age).ok());
        Some(cookie)
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

    let (status, renew, entries) = session.snapshot();
    if renew
        && status == SessionStatus::Changed
        && let Some(id) = session_id.take()
    {
        layer.remove(&id);
    }
    let cookie = match ((status, entries), session_id) {
        ((SessionStatus::Changed, entries), Some(id)) => {
            layer.store(&id, entries);
            layer.refreshed_cookie(id)
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
        ((SessionStatus::Unchanged, _), Some(id)) => layer.refreshed_cookie(id),
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
    pub expires: chrono::DateTime<chrono::Utc>,
}

pub struct SessionStore {
    session_handles: HashMap<SessionId, Arc<Mutex<ManagementSessionHandle>>>,
    session_timestamps: HashMap<SessionId, Instant>,
    /// Idle lifetimes chosen by users; sessions without one use the default.
    session_lifetimes: HashMap<SessionId, Duration>,
}

static SESSION_ID_SESSION_KEY: &str = "session_id";
/// Session entry holding the idle lifetime the user chose, in seconds.
pub static SESSION_LIFETIME_KEY: &str = "session_lifetime";

impl SessionStore {
    pub fn new() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            session_handles: HashMap::new(),
            session_timestamps: HashMap::new(),
            session_lifetimes: HashMap::new(),
        }))
    }

    /// Syncs the session's chosen lifetime, or drops its cookie when the
    /// server-side handle no longer exists. Activity is recorded separately
    /// (`mark_active`) because background requests must not extend a session.
    pub fn touch(&mut self, session: &Session) {
        if let Some(session_id) = session.get::<SessionId>(SESSION_ID_SESSION_KEY) {
            if self.session_handles.contains_key(&session_id) {
                if let Some(seconds) = session.get::<u64>(SESSION_LIFETIME_KEY) {
                    self.session_lifetimes
                        .insert(session_id, Duration::from_secs(seconds));
                }
            } else {
                // The server-side handle is gone (revoked by a password
                // change or expired by the idle vacuum), so the cookie must
                // stop authenticating.
                info!(%session_id, "Session handle is gone, purging HTTP session");
                session.purge();
            }
        };
    }

    /// Records user activity, which extends the session by its lifetime.
    pub fn mark_active(&mut self, session: &Session) {
        if let Some(session_id) = session.get::<SessionId>(SESSION_ID_SESSION_KEY)
            && self.session_handles.contains_key(&session_id)
        {
            self.session_timestamps.insert(session_id, Instant::now());
        }
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
            self.forget(id);
        }
    }

    fn forget(&mut self, id: SessionId) -> bool {
        self.session_timestamps.remove(&id);
        self.session_lifetimes.remove(&id);
        self.session_handles.remove(&id).is_some()
    }

    fn lifetime(&self, id: &SessionId, default: Duration) -> Duration {
        self.session_lifetimes.get(id).copied().unwrap_or(default)
    }

    pub async fn revoke_other_sessions(
        &mut self,
        user_id: uuid::Uuid,
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
                    .is_some_and(|user| user.id == user_id)
            {
                ids.push(*id);
            }
        }
        for id in &ids {
            self.forget(*id);
        }
        ids.len()
    }

    /// The id of the browser session `session` belongs to.
    pub async fn id_of(&self, session: &Session) -> Option<SessionId> {
        match self.handle_for(session) {
            Some(handle) => Some(handle.lock().await.id()),
            None => None,
        }
    }

    /// Snapshot of live authenticated browser sessions, oldest first.
    pub async fn list(&self, default_lifetime: Duration) -> Vec<ManagementSessionSummary> {
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
            let last_active = now_utc - chrono::Duration::from_std(idle).unwrap_or_default();
            let lifetime = self.lifetime(id, default_lifetime);
            sessions.push(ManagementSessionSummary {
                id: *id,
                username: user_info.username.clone(),
                created: handle.created,
                last_active,
                expires: last_active + chrono::Duration::from_std(lifetime).unwrap_or_default(),
            });
        }
        sessions.sort_by_key(|session| session.created);
        sessions
    }

    /// Revoke one browser session. Its cookie stops authenticating on the
    /// next request. Returns `false` when no such session exists.
    pub fn revoke(&mut self, id: SessionId) -> bool {
        self.forget(id)
    }

    /// Drops sessions idle for longer than their lifetime.
    pub async fn vacuum(&mut self, default_lifetime: Duration) {
        let now = Instant::now();
        let to_remove: Vec<_> = self
            .session_timestamps
            .iter()
            .filter(|(id, timestamp)| {
                now.duration_since(**timestamp) > self.lifetime(id, default_lifetime)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in to_remove {
            self.forget(id);
        }
    }
}

/// Ends the browser sessions and closes the proxy sessions of a user, except
/// `keep`. Returns how many were ended.
pub async fn end_user_sessions(
    services: &Services,
    store: &Mutex<SessionStore>,
    user_id: uuid::Uuid,
    keep: Option<SessionId>,
) -> usize {
    let mut ended = store
        .lock()
        .await
        .revoke_other_sessions(user_id, keep)
        .await;
    let state = services.state.write().await;
    for (id, session_state) in state.sessions.iter() {
        if Some(*id) == keep {
            continue;
        }
        let mut session_state = session_state.lock().await;
        if session_state
            .user_info
            .as_ref()
            .is_some_and(|user| user.id == user_id)
        {
            session_state.handle.close();
            ended += 1;
        }
    }
    ended
}

/// Ends a user's sessions after one of their credentials changed. The
/// session making the change is kept.
pub async fn end_sessions_after_credential_change(
    services: &Services,
    store: &Mutex<SessionStore>,
    acting: &Session,
    user_id: uuid::Uuid,
) {
    let keep = store.lock().await.id_of(acting).await;
    end_user_sessions(services, store, user_id, keep).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use gated_common::auth::AuthStateUserInfo;
    use uuid::Uuid;

    fn user_id(username: &str) -> Uuid {
        let mut bytes = [0; 16];
        for (slot, byte) in bytes.iter_mut().zip(username.bytes()) {
            *slot = byte;
        }
        Uuid::from_bytes(bytes)
    }

    async fn add(store: &mut SessionStore, username: &str, at: Instant) -> SessionId {
        let id = Uuid::new_v4();
        store.session_handles.insert(
            id,
            Arc::new(Mutex::new(ManagementSessionHandle {
                id,
                user_info: Some(AuthStateUserInfo {
                    id: user_id(username),
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
        assert_eq!(
            store
                .revoke_other_sessions(user_id("alice"), Some(keep))
                .await,
            1
        );
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
        let listed = store.list(Duration::from_secs(60)).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, alice);
        assert_eq!(listed[0].username, "alice");
        assert!(store.revoke(alice));
        assert!(!store.revoke(alice));
        assert!(store.list(Duration::from_secs(60)).await.is_empty());
    }

    #[test]
    fn lifetime_options_include_the_default_and_stop_at_the_maximum() {
        let minutes = |m: u64| Duration::from_secs(m * 60);
        assert_eq!(
            session_lifetime_options(minutes(30), minutes(24 * 60)),
            [30, 60, 240, 480, 1440].map(minutes)
        );
        assert_eq!(
            session_lifetime_options(minutes(45), minutes(240)),
            [30, 45, 60, 240].map(minutes)
        );
    }

    #[tokio::test]
    async fn idle_expiry_follows_the_lifetime_chosen_for_the_session() {
        let store = SessionStore::new();
        let mut store = store.lock().await;
        let chosen = add(&mut store, "alice", Instant::now()).await;
        let default = add(&mut store, "bob", Instant::now()).await;
        let session = Session::new(BTreeMap::new());
        session.set(SESSION_ID_SESSION_KEY, chosen);
        session.set(SESSION_LIFETIME_KEY, 4 * 3600);
        store.touch(&session);
        let two_hours_ago = Instant::now() - Duration::from_secs(2 * 3600);
        store.session_timestamps.insert(chosen, two_hours_ago);
        store.session_timestamps.insert(default, two_hours_ago);

        let listed = store.list(Duration::from_secs(1800)).await;
        let expires = listed.iter().find(|s| s.id == chosen).map(|s| s.expires);
        let expected = chrono::Utc::now() + chrono::Duration::hours(2);
        assert!(expires.is_some_and(|at| (at - expected).num_seconds().abs() < 5));

        store.vacuum(Duration::from_secs(1800)).await;
        assert!(store.session_handles.contains_key(&chosen));
        assert!(!store.session_handles.contains_key(&default));
    }

    #[test]
    fn cookie_sessions_slide_on_every_load() {
        let layer = SessionLayer::new("s", false, Duration::from_secs(600));
        layer.store("id", BTreeMap::new());
        let soon = Instant::now() + Duration::from_secs(10);
        if let Some(session) = layer.sessions.lock().unwrap().get_mut("id") {
            session.expires_at = soon;
        }
        assert!(layer.load("id").is_some());
        let expires_at = layer
            .sessions
            .lock()
            .unwrap()
            .get("id")
            .map(|s| s.expires_at);
        assert!(expires_at.is_some_and(|at| at > soon + Duration::from_secs(500)));
    }

    #[tokio::test]
    async fn only_reported_activity_extends_a_session() {
        let store = SessionStore::new();
        let mut store = store.lock().await;
        let earlier = Instant::now() - Duration::from_secs(600);
        let id = add(&mut store, "alice", earlier).await;
        let session = Session::new(BTreeMap::new());
        session.set(SESSION_ID_SESSION_KEY, id);

        store.touch(&session);
        assert_eq!(store.session_timestamps.get(&id), Some(&earlier));

        store.mark_active(&session);
        assert!(
            store
                .session_timestamps
                .get(&id)
                .is_some_and(|at| *at > earlier)
        );
    }

    #[test]
    fn polled_endpoints_do_not_count_as_activity() {
        assert!(!counts_as_activity(
            &Method::GET,
            "/admin/api/system/update"
        ));
        assert!(!counts_as_activity(
            &Method::GET,
            "/admin/api/sessions/1234"
        ));
        assert!(!counts_as_activity(
            &Method::GET,
            "/api/admin/encryption/lock-status"
        ));
        assert!(counts_as_activity(
            &Method::POST,
            "/admin/api/system/update/check"
        ));
        assert!(counts_as_activity(
            &Method::DELETE,
            "/admin/api/sessions/closed"
        ));
        assert!(counts_as_activity(
            &Method::GET,
            "/admin/api/sessions-export"
        ));
        assert!(counts_as_activity(&Method::GET, "/api/info"));
    }
}
