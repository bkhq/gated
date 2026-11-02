//! First-run setup: registers the first admin account. Available only while
//! the database has no users.

use std::num::NonZeroU32;
use std::sync::Arc;

use axum::http::request::Parts;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Extension, Router};
use gated_common::Secret;
use gated_common::web::{Data, Json};
use gated_core::Services;
use gated_core::consts::BUILTIN_ADMIN_ROLE_NAME;
use gated_db_entities::User;
use governor::{DefaultKeyedRateLimiter, Quota};
use http::StatusCode;
use sea_orm::{ConnectionTrait, EntityTrait, TransactionTrait};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use super::encryption::{client_ip, error_response, json_response};
use crate::http_service::common::RequestAuthorization;

#[derive(Clone)]
pub struct SetupState {
    limiter: Arc<DefaultKeyedRateLimiter<String>>,
    /// Serializes setup so two concurrent requests cannot both see an empty
    /// user table.
    lock: Arc<Mutex<()>>,
}

impl Default for SetupState {
    fn default() -> Self {
        let quota =
            Quota::per_minute(NonZeroU32::new(5).unwrap_or_else(|| unreachable!("5 is non-zero")));
        Self {
            limiter: Arc::new(DefaultKeyedRateLimiter::keyed(quota)),
            lock: Arc::new(Mutex::new(())),
        }
    }
}

#[derive(Deserialize)]
struct InitRequest {
    /// Not needed when the request carries the `--enable-admin-token` token.
    #[serde(default)]
    bootstrap_token: Option<String>,
    username: String,
    password: String,
}

pub fn routes() -> Router {
    Router::new()
        .route("/status", get(status))
        .route("/init", post(init))
        .layer(Extension(SetupState::default()))
}

async fn needs_setup(db: &impl ConnectionTrait) -> Result<bool, sea_orm::DbErr> {
    Ok(User::Entity::find().one(db).await?.is_none())
}

async fn status(services: Data<Services>) -> Response {
    let Ok(db) = services.db_required().await else {
        return error_response(StatusCode::LOCKED, "db_locked", "Database is locked");
    };
    match needs_setup(&db).await {
        Ok(needs_setup) => json_response(StatusCode::OK, &json!({ "needs_setup": needs_setup })),
        Err(error) => {
            error!(%error, "setup_status_failed");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal error",
            )
        }
    }
}

async fn init(
    req: Parts,
    services: Data<Services>,
    state: Data<SetupState>,
    auth: Option<Data<RequestAuthorization>>,
    Json(body): Json<InitRequest>,
) -> Response {
    let client_ip = client_ip(&req, &services).await;
    let key = client_ip.clone().unwrap_or_else(|| "<unknown>".to_owned());
    if state.limiter.check_key(&key).is_err() {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many attempts",
        );
    }

    let _guard = state.lock.lock().await;
    let Ok(db) = services.db_required().await else {
        return error_response(StatusCode::LOCKED, "db_locked", "Database is locked");
    };
    match needs_setup(&db).await {
        Ok(true) => {}
        Ok(false) => {
            return error_response(
                StatusCode::CONFLICT,
                "already_initialized",
                "Setup is already complete",
            );
        }
        Err(error) => {
            error!(%error, "setup_status_failed");
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Internal error",
            );
        }
    }

    let admin_token = matches!(auth.as_deref(), Some(RequestAuthorization::AdminToken));
    let bootstrap_token = match (
        &body.bootstrap_token,
        &*services.encryption_bootstrap_token.read().await,
    ) {
        (Some(candidate), Some(token)) => token.verify(candidate.trim()),
        _ => false,
    };
    if !admin_token && !bootstrap_token {
        warn!(target: "audit", client_ip = client_ip.as_deref(), "setup_rejected_bad_token");
        return error_response(StatusCode::FORBIDDEN, "forbidden", "Forbidden");
    }

    let username = body.username.trim();
    if username.is_empty() || body.password.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Username and password are required",
        );
    }

    if let Err(error) = create_admin(&db, username, Secret::new(body.password)).await {
        error!(?error, "setup_create_admin_failed");
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Setup failed",
        );
    }
    if let Err(error) = services.clear_encryption_bootstrap_token().await {
        warn!(target: "audit", %error, "failed to delete bootstrap token");
    }

    info!(target: "audit", username, client_ip = client_ip.as_deref(), "setup_completed");
    json_response(StatusCode::CREATED, &json!({ "status": "ok" }))
}

async fn create_admin(
    db: &sea_orm::DatabaseConnection,
    username: &str,
    password: Secret<String>,
) -> anyhow::Result<()> {
    let tx = db.begin().await?;
    gated_core::db::create_user(&tx, username, &password, Some(BUILTIN_ADMIN_ROLE_NAME)).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use gated_common::{GatedConfig, GlobalParams};
    use gated_core::encryption::BootstrapToken;
    use gated_db_entities::SshKey;
    use http::Method;
    use serde_json::Value;
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;

    async fn test_services() -> Services {
        let root = std::env::temp_dir().join(format!("gated-setup-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").expect("write config");
        let mut config = GatedConfig {
            store: Default::default(),
        };
        config.store.database_url = Secret::new("sqlite:data/db".to_owned());
        let params = GlobalParams::new(config_path, false).expect("global params");
        let services = Services::new(config, Some("admin-token".to_owned()), params, None)
            .await
            .expect("services");
        services.open_db_legacy().await.expect("open db");
        services
            .set_encryption_bootstrap_token(Some(BootstrapToken::from_token_for_tests(
                "bootstrap",
                None,
            )))
            .await;
        services
    }

    async fn send(
        app: &Router,
        method: Method,
        uri: &str,
        body: Option<Value>,
        auth: Option<RequestAuthorization>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(match body {
                Some(body) => Body::from(body.to_string()),
                None => Body::empty(),
            })
            .expect("request");
        if let Some(auth) = auth {
            req.extensions_mut().insert(auth);
        }
        let response = app.clone().oneshot(req).await.expect("response");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        (
            status,
            serde_json::from_slice(&body).expect("json response"),
        )
    }

    #[tokio::test]
    async fn init_registers_the_first_admin_once() {
        let services = test_services().await;
        let app = routes().layer(Extension(services.clone()));

        let (status, body) = send(&app, Method::GET, "/status", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "needs_setup": true }));

        let request = |token: &str| json!({ "bootstrap_token": token, "username": "admin", "password": "123" });
        let (status, _) = send(&app, Method::POST, "/init", Some(request("wrong")), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = send(
            &app,
            Method::POST,
            "/init",
            Some(request("bootstrap")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        let db = services.db_required().await.expect("db");
        let admin = User::Entity::find().one(&db).await.expect("query user");
        assert_eq!(admin.map(|u| u.username), Some("admin".to_owned()));
        // SSH keys are generated or imported separately.
        let keys = SshKey::Entity::find().all(&db).await.expect("query keys");
        assert!(keys.is_empty());
        assert!(services.encryption_bootstrap_token.read().await.is_none());

        let (status, body) = send(&app, Method::GET, "/status", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "needs_setup": false }));

        let (status, body) = send(
            &app,
            Method::POST,
            "/init",
            Some(request("bootstrap")),
            Some(RequestAuthorization::AdminToken),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "already_initialized");

        services.close_db().await;
    }

    #[tokio::test]
    async fn admin_token_authorizes_init_without_bootstrap_token() {
        let services = test_services().await;
        let app = routes().layer(Extension(services.clone()));
        let body = json!({ "username": "admin", "password": "123" });

        let (status, _) = send(&app, Method::POST, "/init", Some(body.clone()), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = send(
            &app,
            Method::POST,
            "/init",
            Some(body),
            Some(RequestAuthorization::AdminToken),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        services.close_db().await;
    }
}
