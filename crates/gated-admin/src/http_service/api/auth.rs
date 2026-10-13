use std::num::NonZeroU32;
use std::ops::DerefMut;
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use futures::{SinkExt, StreamExt};
use gated_common::auth::{AuthCredential, AuthResult, AuthState, CredentialKind};
use gated_common::{GatedError, Secret};
use gated_core::logging::http::get_client_ip;
use gated_core::{ConfigProvider, Services};
use governor::{DefaultKeyedRateLimiter, Quota};
use poem::http::StatusCode;
use poem::session::Session;
use poem::web::Data;
use poem::web::websocket::{Message, WebSocket};
use poem::{IntoResponse, Request, Response, handler};
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Enum, Object, OpenApi};
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;

use super::common::logout;
use crate::http_service::common::{
    RequestAuthorization, SessionAuthorization, SessionExt, authorize_session, endpoint_auth,
    get_auth_state_for_request,
};
use crate::http_service::session::SessionStore;

pub struct Api;

/// Maximum credential attempts per `(username, client-IP)` per
/// minute, shared across the `/auth/login` and `/auth/otp` endpoints. The
/// governor token bucket allows a burst of this many attempts and then
/// refills at the same rate, so password and TOTP guessing is throttled
/// while normal interactive logins (a handful of requests) are unaffected.
const LOGIN_MAX_ATTEMPTS_PER_MIN: u32 = 10;

/// Per-`(username, client-IP)` limiter guarding the unauthenticated login
/// and OTP endpoints against brute-force / credential-stuffing. See
/// `gated-core/src/sql_console_rate_limit.rs` for the governor pattern.
static LOGIN_RATE_LIMITER: LazyLock<DefaultKeyedRateLimiter<String>> = LazyLock::new(|| {
    let quota = Quota::per_minute(
        NonZeroU32::new(LOGIN_MAX_ATTEMPTS_PER_MIN)
            .unwrap_or_else(|| unreachable!("LOGIN_MAX_ATTEMPTS_PER_MIN is non-zero")),
    );
    DefaultKeyedRateLimiter::keyed(quota)
});

/// Build the limiter key from the username and the resolved client IP, so a
/// single attacker IP cannot exhaust other users and a single targeted
/// username cannot be hammered from one IP.
async fn login_rate_limit_key(req: &Request, services: &Services, username: &str) -> String {
    let ip = get_client_ip(req, Some(services))
        .await
        .unwrap_or_else(|| "<unknown>".to_owned());
    format!("{username}|{ip}")
}

#[derive(Object)]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Object)]
struct OtpLoginRequest {
    otp: String,
}

#[derive(Enum)]
enum ApiAuthState {
    NotStarted,
    Failed,
    PasswordNeeded,
    OtpNeeded,
    SsoNeeded,
    WebUserApprovalNeeded,
    PublicKeyNeeded,
    Success,
}

#[derive(Object)]
struct LoginFailureResponse {
    state: ApiAuthState,
}

#[derive(ApiResponse)]
enum LoginResponse {
    #[oai(status = 201)]
    Success,

    #[oai(status = 401)]
    Failure(Json<LoginFailureResponse>),

    /// Too many credential attempts for this username/IP.
    #[oai(status = 429)]
    TooManyRequests,
}

#[derive(ApiResponse)]
enum LogoutResponse {
    #[oai(status = 201)]
    Success,
}

#[derive(Object)]
struct AuthStateResponseInternal {
    pub id: String,
    pub protocol: String,
    pub address: Option<String>,
    pub started: DateTime<Utc>,
    pub state: ApiAuthState,
    pub identification_string: String,
}

#[derive(ApiResponse)]
enum AuthStateListResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<AuthStateResponseInternal>>),
    #[oai(status = 404)]
    NotFound,
}

#[derive(ApiResponse)]
enum AuthStateResponse {
    #[oai(status = 200)]
    Ok(Json<AuthStateResponseInternal>),
    #[oai(status = 404)]
    NotFound,
}

const PREFERRED_NEED_CRED_ORDER: &[CredentialKind] = &[
    CredentialKind::PublicKey,
    CredentialKind::Password,
    CredentialKind::Totp,
    CredentialKind::Sso,
    CredentialKind::WebUserApproval,
];

impl From<AuthResult> for ApiAuthState {
    fn from(state: AuthResult) -> Self {
        match state {
            AuthResult::Rejected => ApiAuthState::Failed,
            AuthResult::Need(kinds) => {
                let kind = PREFERRED_NEED_CRED_ORDER
                    .iter()
                    .find(|x| kinds.contains(x))
                    .or(kinds.iter().next());
                match kind {
                    Some(CredentialKind::Password) => ApiAuthState::PasswordNeeded,
                    Some(CredentialKind::Totp) => ApiAuthState::OtpNeeded,
                    Some(CredentialKind::Sso) => ApiAuthState::SsoNeeded,
                    Some(CredentialKind::WebUserApproval) => ApiAuthState::WebUserApprovalNeeded,
                    Some(CredentialKind::PublicKey) => ApiAuthState::PublicKeyNeeded,
                    Some(CredentialKind::Certificate) => {
                        // Certificate authentication is not supported for HTTP protocol
                        // This credential type is primarily for Kubernetes
                        ApiAuthState::Failed
                    }
                    None => ApiAuthState::Failed,
                }
            }
            AuthResult::Accepted { .. } => ApiAuthState::Success,
        }
    }
}

#[OpenApi]
impl Api {
    #[oai(path = "/auth/login", method = "post", operation_id = "login")]
    async fn api_auth_login(
        &self,
        req: &Request,
        session: &Session,
        services: Data<&Services>,
        body: Json<LoginRequest>,
    ) -> poem::Result<LoginResponse> {
        // Throttle before any credential check so password
        // guessing is rate-limited regardless of whether the user exists.
        let rate_key = login_rate_limit_key(req, &services, &body.username).await;
        if LOGIN_RATE_LIMITER.check_key(&rate_key).is_err() {
            metrics::counter!(
                "gated_auth_attempts_total",
                "result" => "rate_limited",
                "method" => "password",
            )
            .increment(1);
            warn!(target: "audit",
                username = %body.username,
                protocol = "http",
                "auth_login_rate_limited"
            );
            return Ok(LoginResponse::TooManyRequests);
        }

        let mut auth_state_store = services.auth_state_store.lock().await;
        let state_arc = match get_auth_state_for_request(
            &body.username,
            session,
            &mut auth_state_store,
        )
        .await
        {
            Err(GatedError::UserNotFound(_)) => {
                metrics::counter!(
                    "gated_auth_attempts_total",
                    "result" => "rejected",
                    "method" => "password",
                )
                .increment(1);
                warn!(target: "audit",
                    username = %body.username,
                    protocol = "http",
                    reason = "user_not_found",
                    "auth_login_rejected"
                );
                return Ok(LoginResponse::Failure(Json(LoginFailureResponse {
                    state: ApiAuthState::Failed,
                })));
            }
            x => x,
        }?;
        let mut state = state_arc.lock().await;

        let mut cp = services.config_provider.lock().await;

        let password_cred = AuthCredential::Password(Secret::new(body.password.clone()));
        if cp
            .validate_credential(&state.user_info().username, &password_cred)
            .await?
        {
            state.add_valid_credential(password_cred);
        }

        match state.verify() {
            AuthResult::Accepted { user_info } => {
                let username = user_info.username.clone();
                auth_state_store.complete(state.id()).await;
                authorize_session(req, user_info).await?;
                metrics::counter!(
                    "gated_auth_attempts_total",
                    "result" => "accepted",
                    "method" => "password",
                )
                .increment(1);
                info!(target: "audit",username = %username, protocol = "http", "auth_login_succeeded");
                Ok(LoginResponse::Success)
            }
            AuthResult::Rejected => {
                metrics::counter!(
                    "gated_auth_attempts_total",
                    "result" => "rejected",
                    "method" => "password",
                )
                .increment(1);
                warn!(target: "audit",
                    username = %body.username,
                    protocol = "http",
                    "auth_login_rejected"
                );
                Ok(LoginResponse::Failure(Json(LoginFailureResponse {
                    state: ApiAuthState::Failed,
                })))
            }
            // `Need(...)`: password was accepted but another factor is
            // still required. Not a rejection — don't count it as one,
            // or dashboards show every MFA step as a failure.
            x => Ok(LoginResponse::Failure(Json(LoginFailureResponse {
                state: x.into(),
            }))),
        }
    }

    #[oai(path = "/auth/otp", method = "post", operation_id = "otpLogin")]
    async fn api_auth_otp_login(
        &self,
        req: &Request,
        session: &Session,
        services: Data<&Services>,
        body: Json<OtpLoginRequest>,
    ) -> poem::Result<LoginResponse> {
        let state_id = session.get_auth_state_id();

        let mut auth_state_store = services.auth_state_store.lock().await;

        let Some(state_arc) = state_id.and_then(|id| auth_state_store.get(&id.0)) else {
            return Ok(LoginResponse::Failure(Json(LoginFailureResponse {
                state: ApiAuthState::NotStarted,
            })));
        };

        let mut state = state_arc.lock().await;
        let username = state.user_info().username.clone();

        // Throttle TOTP guessing per username/IP before checking
        // the code, sharing the bucket with the password login endpoint.
        let rate_key = login_rate_limit_key(req, &services, &username).await;
        if LOGIN_RATE_LIMITER.check_key(&rate_key).is_err() {
            metrics::counter!(
                "gated_auth_attempts_total",
                "result" => "rate_limited",
                "method" => "otp",
            )
            .increment(1);
            warn!(target: "audit",username = %username, protocol = "http", "auth_otp_rate_limited");
            return Ok(LoginResponse::TooManyRequests);
        }

        let mut cp = services.config_provider.lock().await;

        let otp_cred = AuthCredential::Otp(body.otp.clone().into());
        if cp.validate_credential(&username, &otp_cred).await? {
            state.add_valid_credential(otp_cred);
        } else {
            warn!(target: "audit",username = %username, protocol = "http", "auth_otp_invalid");
        }

        match state.verify() {
            AuthResult::Accepted { user_info } => {
                auth_state_store.complete(state.id()).await;
                authorize_session(req, user_info).await?;
                metrics::counter!(
                    "gated_auth_attempts_total",
                    "result" => "accepted",
                    "method" => "otp",
                )
                .increment(1);
                info!(target: "audit",username = %username, protocol = "http", "auth_otp_succeeded");
                Ok(LoginResponse::Success)
            }
            AuthResult::Rejected => {
                metrics::counter!(
                    "gated_auth_attempts_total",
                    "result" => "rejected",
                    "method" => "otp",
                )
                .increment(1);
                Ok(LoginResponse::Failure(Json(LoginFailureResponse {
                    state: ApiAuthState::Failed,
                })))
            }
            // `Need(...)`: the OTP step alone isn't enough — more
            // factors required. Not an OTP failure, don't count it.
            x => Ok(LoginResponse::Failure(Json(LoginFailureResponse {
                state: x.into(),
            }))),
        }
    }

    #[oai(path = "/auth/logout", method = "post", operation_id = "logout")]
    async fn api_auth_logout(
        &self,
        session: &Session,
        session_middleware: Data<&Arc<Mutex<SessionStore>>>,
    ) -> poem::Result<LogoutResponse> {
        let username = session.get_username();
        logout(session, session_middleware.lock().await.deref_mut());
        info!(target: "audit",username = ?username, protocol = "http", "auth_logout");
        Ok(LogoutResponse::Success)
    }

    #[oai(
        path = "/auth/state",
        method = "get",
        operation_id = "get_default_auth_state"
    )]
    async fn api_default_auth_state(
        &self,
        session: &Session,
        services: Data<&Services>,
    ) -> poem::Result<AuthStateResponse> {
        let Some(state_id) = session.get_auth_state_id() else {
            return Ok(AuthStateResponse::NotFound);
        };
        let store = services.auth_state_store.lock().await;
        let Some(state_arc) = store.get(&state_id.0) else {
            return Ok(AuthStateResponse::NotFound);
        };
        serialize_auth_state_inner(state_arc, *services)
            .await
            .map(Json)
            .map(AuthStateResponse::Ok)
    }

    /// Finish a login whose remaining factor was granted out of band (web
    /// user approval from another device). The approve endpoint runs in the
    /// approver's session, so it cannot authorize the requester's HTTP
    /// session; the requester calls this once its auth state reports
    /// `Success`.
    #[oai(
        path = "/auth/state/continue",
        method = "post",
        operation_id = "continue_default_auth"
    )]
    async fn api_continue_default_auth(
        &self,
        req: &Request,
        session: &Session,
        services: Data<&Services>,
    ) -> poem::Result<AuthStateResponse> {
        let Some(state_id) = session.get_auth_state_id() else {
            return Ok(AuthStateResponse::NotFound);
        };
        let mut store = services.auth_state_store.lock().await;
        let Some(state_arc) = store.get(&state_id.0) else {
            return Ok(AuthStateResponse::NotFound);
        };
        let accepted = {
            let state = state_arc.lock().await;
            match state.verify() {
                AuthResult::Accepted { user_info } => Some(user_info),
                _ => None,
            }
        };
        if let Some(user_info) = accepted {
            let username = user_info.username.clone();
            store.complete(&state_id.0).await;
            authorize_session(req, user_info).await?;
            session.clear_auth_state();
            info!(target: "audit",username = %username, protocol = "http", "auth_web_approval_succeeded");
        }
        serialize_auth_state_inner(state_arc, *services)
            .await
            .map(Json)
            .map(AuthStateResponse::Ok)
    }

    #[oai(
        path = "/auth/state",
        method = "delete",
        operation_id = "cancel_default_auth"
    )]
    async fn api_cancel_default_auth(
        &self,
        session: &Session,
        services: Data<&Services>,
    ) -> poem::Result<AuthStateResponse> {
        let Some(state_id) = session.get_auth_state_id() else {
            return Ok(AuthStateResponse::NotFound);
        };
        let mut store = services.auth_state_store.lock().await;
        let Some(state_arc) = store.get(&state_id.0) else {
            return Ok(AuthStateResponse::NotFound);
        };
        state_arc.lock().await.reject();
        store.complete(&state_id.0).await;
        session.clear_auth_state();

        serialize_auth_state_inner(state_arc, *services)
            .await
            .map(Json)
            .map(AuthStateResponse::Ok)
    }

    #[oai(
        path = "/auth/web-auth-requests",
        method = "get",
        operation_id = "get_web_auth_requests",
        transform = "endpoint_auth"
    )]
    async fn get_web_auth_requests(
        &self,
        services: Data<&Services>,
        auth: Option<Data<&RequestAuthorization>>,
    ) -> poem::Result<AuthStateListResponse> {
        let store = services.auth_state_store.lock().await;

        let Some(RequestAuthorization::Session(SessionAuthorization::User(username))) =
            auth.map(|x| x.0)
        else {
            return Ok(AuthStateListResponse::NotFound);
        };

        let state_arcs = store.all_pending_web_auths_for_user(username).await;

        let mut results = vec![];

        for state_arc in state_arcs {
            results.push(serialize_auth_state_inner(state_arc, *services).await?)
        }

        Ok(AuthStateListResponse::Ok(Json(results)))
    }

    #[oai(
        path = "/auth/state/:id",
        method = "get",
        operation_id = "get_auth_state",
        transform = "endpoint_auth"
    )]
    async fn api_auth_state(
        &self,
        services: Data<&Services>,
        auth: Option<Data<&RequestAuthorization>>,
        id: Path<Uuid>,
    ) -> poem::Result<AuthStateResponse> {
        let state_arc = get_auth_state(&id, &services, auth.map(|x| x.0)).await;
        let Some(state_arc) = state_arc else {
            return Ok(AuthStateResponse::NotFound);
        };
        serialize_auth_state_inner(state_arc, *services)
            .await
            .map(Json)
            .map(AuthStateResponse::Ok)
    }

    #[oai(
        path = "/auth/state/:id/approve",
        method = "post",
        operation_id = "approve_auth",
        transform = "endpoint_auth"
    )]
    async fn api_approve_auth(
        &self,
        services: Data<&Services>,
        auth: Option<Data<&RequestAuthorization>>,
        id: Path<Uuid>,
    ) -> poem::Result<AuthStateResponse> {
        let Some(state_arc) = get_auth_state(&id, &services, auth.map(|x| x.0)).await else {
            return Ok(AuthStateResponse::NotFound);
        };

        let auth_result = {
            let mut state = state_arc.lock().await;
            state.add_valid_credential(AuthCredential::WebUserApproval);
            state.verify()
        };

        if let AuthResult::Accepted { .. } = auth_result {
            services.auth_state_store.lock().await.complete(&id).await;
        }
        serialize_auth_state_inner(state_arc, *services)
            .await
            .map(Json)
            .map(AuthStateResponse::Ok)
    }

    #[oai(
        path = "/auth/state/:id/reject",
        method = "post",
        operation_id = "reject_auth",
        transform = "endpoint_auth"
    )]
    async fn api_reject_auth(
        &self,
        services: Data<&Services>,
        auth: Option<Data<&RequestAuthorization>>,
        id: Path<Uuid>,
    ) -> poem::Result<AuthStateResponse> {
        let Some(state_arc) = get_auth_state(&id, &services, auth.map(|x| x.0)).await else {
            return Ok(AuthStateResponse::NotFound);
        };
        state_arc.lock().await.reject();
        services.auth_state_store.lock().await.complete(&id).await;
        serialize_auth_state_inner(state_arc, *services)
            .await
            .map(Json)
            .map(AuthStateResponse::Ok)
    }
}

async fn get_auth_state(
    id: &Uuid,
    services: &Services,
    auth: Option<&RequestAuthorization>,
) -> Option<Arc<Mutex<AuthState>>> {
    let store = services.auth_state_store.lock().await;

    let RequestAuthorization::Session(SessionAuthorization::User(username)) = auth? else {
        return None;
    };

    let state_arc = store.get(id)?;

    {
        let state = state_arc.lock().await;
        if &state.user_info().username != username {
            return None;
        }
    }

    Some(state_arc)
}

async fn serialize_auth_state_inner(
    state_arc: Arc<Mutex<AuthState>>,
    services: &Services,
) -> poem::Result<AuthStateResponseInternal> {
    let state = state_arc.lock().await;

    let session_state_store = services.state.read().await;
    let session_state = state
        .session_id()
        .and_then(|session_id| session_state_store.sessions.get(&session_id));

    let peer_addr = match session_state {
        Some(x) => x.lock().await.remote_address,
        None => None,
    };

    Ok(AuthStateResponseInternal {
        id: state.id().to_string(),
        protocol: state.protocol().to_string(),
        address: peer_addr.map(|x| x.ip().to_string()),
        started: *state.started(),
        state: state.verify().into(),
        identification_string: state.identification_string().to_owned(),
    })
}

#[handler]
pub async fn api_get_web_auth_requests_stream(
    req: &Request,
    ws: WebSocket,
    auth: Option<Data<&RequestAuthorization>>,
    services: Data<&Services>,
) -> anyhow::Result<Response> {
    // Reject cross-site WebSocket hijacking (CSWSH) before upgrading.
    if !crate::http_service::middleware::is_ws_origin_allowed(req, &services).await {
        warn!(target: "audit",protocol = "web_auth_stream", "web_auth_stream_origin_rejected");
        return Ok(Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body("Invalid Origin"));
    }

    let auth_state_store = services.auth_state_store.clone();

    let username = match auth.map(|x| x.0.clone()) {
        Some(RequestAuthorization::Session(SessionAuthorization::User(username))) => Some(username),
        _ => None,
    };

    let mut rx = {
        let mut s = auth_state_store.lock().await;
        s.subscribe_web_auth_request()
    };

    Ok(ws
        .on_upgrade(|socket| async move {
            let (mut sink, _) = socket.split();

            while let Ok(id) = rx.recv().await {
                let auth_state_store = auth_state_store.lock().await;
                if let Some(state) = auth_state_store.get(&id) {
                    let state = state.lock().await;
                    if Some(state.user_info().username.as_ref()) == username.as_deref() {
                        sink.send(Message::Text(id.to_string())).await?;
                    }
                }
            }

            Ok::<(), anyhow::Error>(())
        })
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared login/OTP limiter must reject attempts once
    /// the per-`(username, IP)` burst is exhausted.
    #[test]
    fn login_rate_limiter_trips_after_burst() {
        // Unique key so this test is independent of the process-global
        // limiter's state from other tests.
        let key = "gated-033-rate-limit-test|203.0.113.7".to_owned();
        for _ in 0..LOGIN_MAX_ATTEMPTS_PER_MIN {
            assert!(LOGIN_RATE_LIMITER.check_key(&key).is_ok());
        }
        assert!(LOGIN_RATE_LIMITER.check_key(&key).is_err());
    }
}
