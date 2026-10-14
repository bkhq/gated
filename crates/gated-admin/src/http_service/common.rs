use core::str;
use std::sync::Arc;

use anyhow::Context;
use axum::extract::Request;
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::http::header::HOST;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use gated_common::auth::{AuthState, AuthStateUserInfo, CredentialKind};
use gated_common::{GatedError, ProtocolName, Secret};
use gated_core::consts::BUILTIN_ADMIN_ROLE_NAME;
use gated_core::{AuthStateStore, ConfigProvider, Services};
use gated_sso::CoreIdToken;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use sea_orm::{ColumnTrait, EntityTrait, ModelTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::http_service::session::{Session, SessionStore};

pub const PROTOCOL_NAME: ProtocolName = "HTTP";
static TARGET_SESSION_KEY: &str = "target_name";
static AUTH_SESSION_KEY: &str = "auth";
static AUTH_STATE_ID_SESSION_KEY: &str = "auth_state_id";
static AUTH_SSO_LOGIN_STATE: &str = "auth_sso_login_state";
pub static SESSION_COOKIE_NAME: &str = "gated-http-session";
static X_GATED_TOKEN: HeaderName = HeaderName::from_static("x-gated-token");

/// Check if a host is localhost or a raw IP address.
///
/// Browsers reject cookies whose Domain attribute is an IP, so we treat any
/// IP host the same as localhost: omit the Domain attribute and let the
/// browser scope the cookie to the exact host.
pub fn is_localhost_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    bare.parse::<std::net::IpAddr>().is_ok()
}

/// Strip the port from a `Host` header value. IPv6 literals are bracketed
/// (`[::1]:8080`), so a plain split on the first `:` would return `[`.
pub fn host_without_port(host: &str) -> &str {
    if host.starts_with('[') {
        host.find(']')
            .and_then(|end| host.get(..=end))
            .unwrap_or(host)
    } else {
        host.split(':').next().unwrap_or(host)
    }
}

fn normalize_cookie_domain(domain: &str) -> &str {
    domain.strip_prefix('.').unwrap_or(domain)
}

#[derive(Serialize, Deserialize)]
pub struct SsoLoginState {
    pub token: CoreIdToken,
    pub provider: String,
    pub supports_single_logout: bool,
}

pub trait SessionExt {
    fn get_target_name(&self) -> Option<String>;
    fn get_username(&self) -> Option<String>;
    fn get_auth(&self) -> Option<SessionAuthorization>;
    fn set_auth(&self, auth: SessionAuthorization);
    fn get_auth_state_id(&self) -> Option<AuthStateId>;
    fn clear_auth_state(&self);

    fn get_sso_login_state(&self) -> Option<SsoLoginState>;
    fn set_sso_login_state(&self, token: SsoLoginState);
}

impl SessionExt for Session {
    fn get_target_name(&self) -> Option<String> {
        self.get(TARGET_SESSION_KEY)
    }

    fn get_username(&self) -> Option<String> {
        self.get_auth().map(|x| x.username().to_owned())
    }

    fn get_auth(&self) -> Option<SessionAuthorization> {
        self.get(AUTH_SESSION_KEY)
    }

    fn set_auth(&self, auth: SessionAuthorization) {
        self.set(AUTH_SESSION_KEY, auth);
    }

    fn get_auth_state_id(&self) -> Option<AuthStateId> {
        self.get(AUTH_STATE_ID_SESSION_KEY)
    }

    fn clear_auth_state(&self) {
        self.remove(AUTH_STATE_ID_SESSION_KEY)
    }

    fn get_sso_login_state(&self) -> Option<SsoLoginState> {
        self.get::<String>(AUTH_SSO_LOGIN_STATE)
            .and_then(|x| serde_json::from_str(&x).ok())
    }

    fn set_sso_login_state(&self, state: SsoLoginState) {
        if let Ok(json) = serde_json::to_string(&state) {
            self.set(AUTH_SSO_LOGIN_STATE, json)
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AuthStateId(pub Uuid);

#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum SessionAuthorization {
    User(String),
    Ticket {
        username: String,
        target_name: String,
    },
}

impl SessionAuthorization {
    pub fn username(&self) -> &String {
        match self {
            Self::User(username) => username,
            Self::Ticket { username, .. } => username,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum RequestAuthorization {
    Session(SessionAuthorization),
    UserToken { username: String },
    AdminToken,
}

impl RequestAuthorization {
    /// Ticket scope supplements, and never replaces, the user's RBAC check.
    pub fn permits_target(&self, requested_target: &str) -> bool {
        match self {
            Self::Session(SessionAuthorization::Ticket { target_name, .. }) => {
                target_name == requested_target
            }
            _ => true,
        }
    }

    pub fn username(&self) -> Option<&String> {
        match self {
            Self::Session(auth) => Some(auth.username()),
            Self::UserToken { username } => Some(username),
            Self::AdminToken => None,
        }
    }
}

pub async fn is_user_admin(
    services: &Services,
    auth: &RequestAuthorization,
) -> Result<bool, GatedError> {
    let username = match auth {
        RequestAuthorization::Session(SessionAuthorization::User(username)) => username,
        RequestAuthorization::Session(SessionAuthorization::Ticket { .. }) => return Ok(false),
        RequestAuthorization::UserToken { username } => username,
        RequestAuthorization::AdminToken => return Ok(true),
    };

    let db = services.db_required().await?;
    let Some(user) = gated_db_entities::User::Entity::find()
        .filter(gated_db_entities::User::Column::Username.eq(username.as_str()))
        .one(&db)
        .await?
    else {
        return Ok(false);
    };
    let roles = user
        .find_related(gated_db_entities::Role::Entity)
        .all(&db)
        .await?;
    Ok(roles.iter().any(|r| r.name == BUILTIN_ADMIN_ROLE_NAME))
}

fn missing_data(name: &'static str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("data of type `{name}` was not found"),
    )
        .into_response()
}

/// Rejects requests whose authorization does not belong to an administrator.
pub async fn require_admin(request: Request, next: Next) -> Response {
    let Some(auth) = request.extensions().get::<RequestAuthorization>().cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(services) = request.extensions().get::<Services>().cloned() else {
        return missing_data("Services");
    };
    match is_user_admin(&services, &auth).await {
        Ok(true) => next.run(request).await,
        Ok(false) => StatusCode::FORBIDDEN.into_response(),
        Err(error) => error.into_response(),
    }
}

/// Resolves the session or API token of a request into a
/// [`RequestAuthorization`] extension.
pub(crate) async fn inject_request_authorization(mut request: Request, next: Next) -> Response {
    let Some(session) = request.extensions().get::<Session>().cloned() else {
        return missing_data("Session");
    };
    let Some(services) = request.extensions().get::<Services>().cloned() else {
        return missing_data("Services");
    };

    let mut session_auth = session.get_auth();
    if session_auth.is_some() {
        let config = services.config.read().await;
        let authorized_base_host = config
            .store
            .http
            .cookie_domain
            .as_deref()
            .map(normalize_cookie_domain)
            .map(str::to_owned)
            .or_else(|| {
                config
                    .construct_external_url(None, None)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
            });

        if let Some(base_host) = authorized_base_host {
            let request_host = request_host(request.headers(), request.uri());

            if let Some(host) = request_host {
                // Validate request host matches base host or is a subdomain/localhost
                let is_localhost = is_localhost_host(&host);
                let is_authorized = host == base_host
                    || host.ends_with(&format!(".{}", base_host))
                    || (is_localhost && base_host != "localhost" && base_host != "127.0.0.1");

                if !is_authorized {
                    tracing::warn!(
                        "Session cookie rejected: request host '{}' is not authorized (base host: '{}'). Clearing session.",
                        host,
                        base_host
                    );
                    session.clear();
                    session_auth = None;
                }
            }
        }
    }

    let auth = match session_auth {
        Some(auth) => Some(RequestAuthorization::Session(auth)),
        None => match request.headers().get(&X_GATED_TOKEN) {
            Some(token_from_header) => {
                let Ok(token_from_header) = token_from_header.to_str() else {
                    return StatusCode::BAD_REQUEST.into_response();
                };
                // Compare the configured admin token in constant
                // time. Byte `==` short-circuits on the first mismatch and
                // leaks how many leading bytes were guessed correctly.
                let admin_token_matches = services
                    .admin_token
                    .load()
                    .as_deref()
                    .map(|expected| Secret::new(expected.clone()).ct_eq(token_from_header))
                    .unwrap_or(false);
                if admin_token_matches {
                    Some(RequestAuthorization::AdminToken)
                } else {
                    let user = services
                        .config_provider
                        .lock()
                        .await
                        .validate_api_token(token_from_header)
                        .await;
                    match user {
                        Ok(Some(user)) => Some(RequestAuthorization::UserToken {
                            username: user.username,
                        }),
                        Ok(None) => None,
                        Err(error) => return error.into_response(),
                    }
                }
            }
            None => None,
        },
    };

    if let Some(auth) = auth {
        request.extensions_mut().insert(auth);
    }
    next.run(request).await
}

/// Host the request was addressed to, without the port.
pub fn request_host(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    headers
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .map(|h| host_without_port(h).to_string())
        .or_else(|| uri.host().map(|x| x.to_string()))
}

/// Answers 401 unless the request carries an authorization.
pub async fn require_auth(request: Request, next: Next) -> Response {
    if request.extensions().get::<RequestAuthorization>().is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

/// Sends unauthenticated page requests to the login page.
pub async fn page_auth(request: Request, next: Next) -> Response {
    if request.extensions().get::<RequestAuthorization>().is_none() {
        return gateway_redirect(request.uri());
    }
    next.run(request).await
}

/// Runs `task` on the upgraded socket and discards its result.
pub fn upgrade<F, Fut, T>(ws: WebSocketUpgrade, task: F) -> Response
where
    F: FnOnce(WebSocket) -> Fut + Send + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    ws.on_upgrade(move |socket| async move {
        task(socket).await;
    })
}

pub fn gateway_redirect(uri: &Uri) -> Response {
    let path = uri
        .path_and_query()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "".into());

    let path = format!(
        "/ui/auth/login?next={}",
        utf8_percent_encode(&path, NON_ALPHANUMERIC),
    );

    Redirect::temporary(&path).into_response()
}

pub async fn get_auth_state_for_request(
    username: &str,
    session: &Session,
    store: &mut AuthStateStore,
) -> Result<Arc<Mutex<AuthState>>, GatedError> {
    if let Some(id) = session.get_auth_state_id()
        && !store.contains_key(&id.0)
    {
        session.remove(AUTH_STATE_ID_SESSION_KEY)
    }

    if let Some(id) = session.get_auth_state_id() {
        let state = store.get(&id.0).ok_or(GatedError::InconsistentState)?;

        let existing_matched = state.lock().await.user_info().username == username;
        if existing_matched {
            return Ok(state);
        }
    }

    let (id, state) = store
        .create(
            None,
            username,
            crate::http_service::common::PROTOCOL_NAME,
            &[
                CredentialKind::Password,
                CredentialKind::Sso,
                CredentialKind::Totp,
            ],
        )
        .await?;
    session.set(AUTH_STATE_ID_SESSION_KEY, AuthStateId(id));
    Ok(state)
}

pub async fn authorize_session(
    parts: &Parts,
    user_info: AuthStateUserInfo,
) -> Result<(), GatedError> {
    let session_middleware = parts
        .extensions
        .get::<Arc<Mutex<SessionStore>>>()
        .context("SessionStore not in request")?;
    let session = parts
        .extensions
        .get::<Session>()
        .context("Session not in request")?;

    let server_handle = session_middleware.lock().await.create_handle_for(session);
    server_handle
        .lock()
        .await
        .set_user_info(user_info.clone())
        .await?;
    let services = parts
        .extensions
        .get::<Services>()
        .context("Services not in request")?;
    let db = services.db_required().await?;
    let id = server_handle.lock().await.id();
    use sea_orm::{ActiveModelTrait, Set};
    let audit = gated_db_entities::ManagementAudit::ActiveModel {
        id: Set(uuid::Uuid::new_v4()),
        session_id: Set(id),
        timestamp: Set(chrono::Utc::now()),
        username: Set(Some(user_info.username.clone())),
        text: Set("Management login".into()),
        values: Set(
            serde_json::json!({ "event": "auth.login", "actor": user_info.username, "plane": "management" }),
        ),
    };
    if let Err(error) = audit.insert(&db).await {
        session_middleware.lock().await.remove_session(session);
        return Err(error.into());
    }
    session.set_auth(SessionAuthorization::User(user_info.username));

    Ok(())
}

#[cfg(test)]
mod audit_regression_tests {
    use super::*;

    #[test]
    fn host_parsing_keeps_ipv6_literals_intact() {
        assert_eq!(host_without_port("example.com:8443"), "example.com");
        assert_eq!(host_without_port("example.com"), "example.com");
        assert_eq!(host_without_port("[::1]:8888"), "[::1]");
        assert_eq!(host_without_port("[::1]"), "[::1]");
        assert!(is_localhost_host("[::1]"));
        assert!(is_localhost_host("127.0.0.1"));
        assert!(!is_localhost_host("example.com"));
    }

    #[test]
    fn ticket_target_scope_is_preserved() {
        let ticket = RequestAuthorization::Session(SessionAuthorization::Ticket {
            username: "alice".into(),
            target_name: "target-a".into(),
        });
        assert!(ticket.permits_target("target-a"));
        assert!(!ticket.permits_target("target-b"));
        let user = RequestAuthorization::UserToken {
            username: "alice".into(),
        };
        assert!(user.permits_target("target-b"));
    }

    #[test]
    fn login_redirect_uses_current_router_and_preserves_destination() {
        let response = gateway_redirect(&Uri::from_static("/protected?x=1"));
        assert_eq!(
            response.headers()["location"],
            "/ui/auth/login?next=%2Fprotected%3Fx%3D1"
        );
    }
}
