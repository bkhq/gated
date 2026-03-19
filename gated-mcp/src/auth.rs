use axum::http::HeaderMap;
use tracing::*;
use gated_core::{ConfigProvider, Services};

use crate::protocol::JsonRpcError;

/// Authenticated caller identity.
pub enum AuthContext {
    /// Admin token grants full access.
    Admin,
    /// User API token with the associated username.
    User { username: String },
}

impl AuthContext {
    pub fn is_admin(&self) -> bool {
        matches!(self, AuthContext::Admin)
    }

    pub fn username(&self) -> Option<&str> {
        match self {
            AuthContext::Admin => None,
            AuthContext::User { username } => Some(username),
        }
    }
}

const AUTH_ERROR_CODE: i64 = -32001;

/// Extract the bearer token from the `Authorization: Bearer <token>` header.
fn extract_bearer_token<'a>(headers: &'a HeaderMap) -> Option<&'a str> {
    headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

/// Authenticate the request using the `Authorization: Bearer <token>` header.
///
/// Supports two token types:
/// - Admin token (set via `--enable-admin-token` / `GATED_ADMIN_TOKEN`)
/// - User API token (stored in the database with an expiry)
pub async fn authenticate(
    services: &Services,
    headers: &HeaderMap,
) -> Result<AuthContext, JsonRpcError> {
    let token = extract_bearer_token(headers).ok_or_else(|| JsonRpcError {
        code: AUTH_ERROR_CODE,
        message: "Missing or malformed Authorization header. Expected: Bearer <token>".into(),
        data: None,
    })?;

    // Check admin token first
    {
        let admin_token = services.admin_token.lock().await;
        if let Some(ref admin) = *admin_token {
            if token == admin {
                debug!("MCP authenticated as admin");
                return Ok(AuthContext::Admin);
            }
        }
    }

    // Check user API token
    {
        let mut config_provider = services.config_provider.lock().await;
        match config_provider.validate_api_token(token).await {
            Ok(Some(user)) => {
                debug!(username = %user.username, "MCP authenticated as user");
                return Ok(AuthContext::User {
                    username: user.username,
                });
            }
            Ok(None) => {}
            Err(e) => {
                error!(?e, "Failed to validate API token");
            }
        }
    }

    Err(JsonRpcError {
        code: AUTH_ERROR_CODE,
        message: "Invalid or expired token".into(),
        data: None,
    })
}
