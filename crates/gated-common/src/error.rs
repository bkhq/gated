use std::error::Error;

use gated_ca::CaError;
use gated_sso::SsoError;
use gated_tls::RustlsSetupError;
use uuid::Uuid;

#[derive(thiserror::Error, Debug)]
pub enum GatedError {
    #[error("database error: {0}")]
    DatabaseError(#[from] sea_orm::DbErr),
    #[error("ticket not found: {0}")]
    InvalidTicket(Uuid),
    #[error("invalid credential type")]
    InvalidCredentialType,
    #[error(transparent)]
    Other(Box<dyn Error + Send + Sync>),
    #[error("user {0} not found")]
    UserNotFound(String),
    #[error("role {0} not found")]
    RoleNotFound(String),
    #[error("not found")]
    NotFound,
    #[error("failed to parse URL: {0}")]
    UrlParse(#[from] url::ParseError),
    #[error("deserialization failed: {0}")]
    DeserializeJson(#[from] serde_json::Error),
    #[error("no valid Host header found and `external_host` config option is not set")]
    ExternalHostUnknown,
    #[error("current hostname ({0}) is not on the whitelist ({1:?})")]
    ExternalHostNotWhitelisted(String, Vec<String>),
    #[error("URL contains no host")]
    NoHostInUrl,
    #[error("Inconsistent state error")]
    InconsistentState,
    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
    #[error(transparent)]
    Sso(#[from] SsoError),
    #[error(transparent)]
    Ca(#[from] CaError),
    #[error(transparent)]
    RusshKeys(#[from] russh::keys::Error),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    RateLimiterInsufficientCapacity(#[from] governor::InsufficientCapacity),
    #[error("Invalid rate limiter quota: {0}")]
    RateLimiterInvalidQuota(u32),
    #[error("Session end")]
    SessionEnd,
    #[error("rcgen: {0}")]
    RcGen(#[from] rcgen::Error),
    #[error("rustls setup: {0}")]
    TlsSetup(#[from] RustlsSetupError),
    #[error("reqwest: {0}")]
    Reqwest(#[from] reqwest::Error),
}

impl GatedError {
    /// Map the typed error variant to a sensible HTTP status. Variants
    /// that can only result from server-side faults (DB / CA / TLS /
    /// I/O / SSO network failures) stay 500. Anything that can
    /// be traced back to malformed client input, an unknown entity, or
    /// an expired session gets a 4xx so callers (and dashboards) can
    /// distinguish operator-actionable server faults from normal client
    /// errors instead of seeing every failure as a 500.
    pub fn status_code(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            // Client input / lookup misses → 400 / 404.
            Self::InvalidTicket(_) => StatusCode::NOT_FOUND,
            Self::UserNotFound(_) | Self::RoleNotFound(_) | Self::NotFound => StatusCode::NOT_FOUND,
            Self::InvalidCredentialType
            | Self::UrlParse(_)
            | Self::DeserializeJson(_)
            | Self::ExternalHostNotWhitelisted(_, _)
            | Self::NoHostInUrl
            | Self::RateLimiterInvalidQuota(_)
            | Self::RusshKeys(_) => StatusCode::BAD_REQUEST,

            // Session already closed — Gone is the closest match, and
            // distinguishes from an auth-layer 401 so the client can
            // know to re-auth rather than retry.
            Self::SessionEnd => StatusCode::GONE,

            // Upstream HTTP failure (reqwest talks to SSO / webhook
            // endpoints). 502 makes it clear this isn't a gateway bug.
            Self::Reqwest(_) => StatusCode::BAD_GATEWAY,

            // Everything else — DB, CA, TLS, SSO, I/O,
            // rate-limiter, config, anyhow-wrapped. All of these mean
            // the server couldn't do its job; the admin needs to see a
            // 500 in their logs, not a 400.
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl GatedError {
    pub fn other<E: Error + Send + Sync + 'static>(err: E) -> Self {
        Self::Other(Box::new(err))
    }
}

impl axum::response::IntoResponse for GatedError {
    fn into_response(self) -> axum::response::Response {
        let details = crate::web::ErrorDetails(format!("{self:?}"));
        let mut response = (self.status_code(), self.to_string()).into_response();
        response.extensions_mut().insert(details);
        response
    }
}
