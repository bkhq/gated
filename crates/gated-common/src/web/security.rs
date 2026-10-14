use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::header::COOKIE;
use axum::http::request::Parts;
use utoipa::openapi::path::Operation;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityRequirement, SecurityScheme};

use super::doc::ApiArgument;
use crate::http_headers::X_GATED_TOKEN;

const SESSION_COOKIE_NAME: &str = "gated-http-session";
const TOKEN_SCHEME: &str = "TokenSecurityScheme";
const COOKIE_SCHEME: &str = "CookieSecurityScheme";

/// Requires a credential to be presented, as an API token header or as the
/// session cookie. Whether it is valid is decided by the authorization layer.
#[derive(Debug, Clone, Copy)]
pub struct AnySecurityScheme;

fn has_session_cookie(parts: &Parts) -> bool {
    parts
        .headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.split_once('='))
        .any(|(name, _)| name.trim() == SESSION_COOKIE_NAME)
}

impl<S: Send + Sync> FromRequestParts<S> for AnySecurityScheme {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let has_token = parts
            .headers
            .get(&X_GATED_TOKEN)
            .is_some_and(|value| value.to_str().is_ok());
        if has_token || has_session_cookie(parts) {
            Ok(Self)
        } else {
            Err((StatusCode::UNAUTHORIZED, "authorization error"))
        }
    }
}

impl ApiArgument for AnySecurityScheme {
    fn document(operation: &mut Operation) {
        operation.security = Some(vec![
            SecurityRequirement::new::<_, [&str; 0], &str>(TOKEN_SCHEME, []),
            SecurityRequirement::new::<_, [&str; 0], &str>(COOKIE_SCHEME, []),
        ]);
    }
}

pub fn security_schemes() -> [(&'static str, SecurityScheme); 2] {
    [
        (
            COOKIE_SCHEME,
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new(SESSION_COOKIE_NAME))),
        ),
        (
            TOKEN_SCHEME,
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("X-Gated-Token"))),
        ),
    ]
}
