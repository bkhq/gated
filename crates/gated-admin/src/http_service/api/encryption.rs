use std::num::NonZeroU32;
use std::sync::Arc;

use gated_core::encryption::migration::{
    detect_existing_database, ExistingSqliteDatabase, MigrationOptions,
};
use gated_core::encryption::EncryptionStatus;
use gated_core::logging::http::get_client_ip;
use gated_core::Services;
use governor::{DefaultKeyedRateLimiter, Quota};
use http::StatusCode;
use poem::web::{Data, Json};
use poem::{handler, EndpointExt, IntoEndpoint, IntoResponse, Request, Response, Route};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{error, info, warn};

use crate::http_service::common::{is_user_admin, RequestAuthorization};

const RETRY_AFTER_SECS: u64 = 60;

#[derive(Clone)]
pub struct EncryptionAdminState {
    limiter: Arc<DefaultKeyedRateLimiter<String>>,
}

impl Default for EncryptionAdminState {
    fn default() -> Self {
        let quota =
            Quota::per_minute(NonZeroU32::new(5).unwrap_or_else(|| unreachable!("5 is non-zero")));
        Self {
            limiter: Arc::new(DefaultKeyedRateLimiter::keyed(quota)),
        }
    }
}

#[derive(Deserialize)]
struct InitRequest {
    bootstrap_token: String,
    master_password: String,
}

#[derive(Deserialize)]
struct UnlockRequest {
    master_password: String,
}

#[derive(Deserialize)]
struct RekeyMasterRequest {
    old_password: String,
    new_password: String,
}

#[derive(Serialize)]
struct StatusResponse {
    status: &'static str,
    db_ready: bool,
    retry_after: Option<u64>,
}

pub fn routes() -> impl IntoEndpoint {
    Route::new()
        .at("/lock-status", poem::get(lock_status))
        .at("/status", poem::get(lock_status))
        .at("/init", poem::post(init))
        .at("/unlock", poem::post(unlock))
        .at("/lock", poem::post(lock))
        .at("/rekey-master", poem::post(rekey_master))
        .data(EncryptionAdminState::default())
}

#[handler]
async fn lock_status(services: Data<&Services>) -> Response {
    let status = match runtime(services.0).await {
        None => "disabled",
        Some(runtime) => status_name(&runtime.status().await),
    };
    let db_ready = services.db.read().await.is_some();
    json_response(
        StatusCode::OK,
        &StatusResponse {
            status,
            db_ready,
            retry_after: None,
        },
    )
}

#[handler]
async fn init(
    req: &Request,
    services: Data<&Services>,
    state: Data<&EncryptionAdminState>,
    Json(body): Json<InitRequest>,
) -> Response {
    let client_ip = client_ip(req, services.0).await;
    if rate_limited(&state, &client_ip) {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many attempts",
        );
    }

    let Some(runtime) = runtime(services.0).await else {
        return error_response(
            StatusCode::CONFLICT,
            "encryption_disabled",
            "Encryption is disabled",
        );
    };
    if !matches!(runtime.status().await, EncryptionStatus::Uninitialized) {
        return error_response(
            StatusCode::CONFLICT,
            "already_initialized",
            "Encryption is already initialized",
        );
    }
    let existing_database = match existing_sqlite_database(services.0).await {
        Ok(existing) => existing,
        Err(error) => {
            warn!(target: "audit",%error, "encryption_init_database_detection_failed");
            return error_response(
                StatusCode::CONFLICT,
                "database_detection_failed",
                "Encryption init failed",
            );
        }
    };
    if matches!(
        existing_database,
        ExistingSqliteDatabase::EncryptedOrInvalid
    ) {
        return error_response(
            StatusCode::CONFLICT,
            "database_not_plaintext",
            "Existing sqlite database is not readable plaintext",
        );
    }

    let Some(token) = services.encryption_bootstrap_token.read().await.clone() else {
        audit_failure(
            "encryption_unlock_failed",
            client_ip.as_deref(),
            "missing_bootstrap_token",
        );
        return error_response(StatusCode::FORBIDDEN, "forbidden", "Forbidden");
    };
    if !token.verify(body.bootstrap_token.trim()) {
        audit_failure(
            "encryption_unlock_failed",
            client_ip.as_deref(),
            "bad_bootstrap_token",
        );
        return error_response(StatusCode::FORBIDDEN, "forbidden", "Forbidden");
    }

    let init_result = if matches!(existing_database, ExistingSqliteDatabase::Plaintext) {
        init_with_plaintext_migration(
            services.0,
            &runtime,
            SecretString::from(body.master_password),
        )
        .await
    } else {
        runtime
            .init(SecretString::from(body.master_password))
            .await
            .map(|()| None)
    };

    match init_result {
        Ok(plaintext_backup) => {
            if let Err(error) = open_unlocked_db(services.0, &runtime).await {
                error!(%error, "encryption_init_open_db_failed");
                runtime.lock().await;
                services.close_db().await;
                return error_response(StatusCode::UNAUTHORIZED, "unauthorized", "Unauthorized");
            }
            if let Err(error) = services.clear_encryption_bootstrap_token().await {
                warn!(target: "audit",%error, "failed to delete encryption bootstrap token");
            }
            services.notify_unlocked().await;
            info!(target: "audit",
                client_ip = client_ip.as_deref(),
                "encryption_init_succeeded"
            );
            // The pre-migration plaintext copy is kept for recovery; it holds
            // every secret unencrypted until the operator deletes it.
            let plaintext_backup = plaintext_backup.map(|path| path.display().to_string());
            if let Some(path) = &plaintext_backup {
                warn!(target: "audit", plaintext_backup = %path, "encryption_plaintext_backup_retained");
            }
            json_response(
                StatusCode::CREATED,
                &json!({"status": "unlocked", "plaintext_backup": plaintext_backup}),
            )
        }
        Err(error) => {
            audit_failure(
                "encryption_unlock_failed",
                client_ip.as_deref(),
                "init_failed",
            );
            warn!(target: "audit",%error, "encryption_init_failed");
            error_response(
                StatusCode::CONFLICT,
                "init_failed",
                "Encryption init failed",
            )
        }
    }
}

#[handler]
async fn unlock(
    req: &Request,
    services: Data<&Services>,
    state: Data<&EncryptionAdminState>,
    Json(body): Json<UnlockRequest>,
) -> Response {
    let client_ip = client_ip(req, services.0).await;
    if rate_limited(&state, &client_ip) {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many attempts",
        );
    }

    let Some(runtime) = runtime(services.0).await else {
        return error_response(
            StatusCode::CONFLICT,
            "encryption_disabled",
            "Encryption is disabled",
        );
    };
    if !matches!(runtime.status().await, EncryptionStatus::Locked) {
        return error_response(
            StatusCode::CONFLICT,
            "invalid_state",
            "Invalid encryption state",
        );
    }

    match runtime
        .unlock(SecretString::from(body.master_password))
        .await
    {
        Ok(()) => {
            if let Err(error) = open_unlocked_db(services.0, &runtime).await {
                error!(%error, "encryption_unlock_open_db_failed");
                runtime.lock().await;
                services.close_db().await;
                audit_failure(
                    "encryption_unlock_failed",
                    client_ip.as_deref(),
                    "open_db_failed",
                );
                return error_response(StatusCode::UNAUTHORIZED, "unauthorized", "Unauthorized");
            }
            services.notify_unlocked().await;
            info!(target: "audit",
                client_ip = client_ip.as_deref(),
                "encryption_unlock_succeeded"
            );
            json_response(StatusCode::OK, &json!({"status": "unlocked"}))
        }
        Err(error) => {
            audit_failure(
                "encryption_unlock_failed",
                client_ip.as_deref(),
                "unlock_failed",
            );
            warn!(target: "audit",%error, client_ip = client_ip.as_deref(), "encryption_unlock_failed");
            error_response(StatusCode::UNAUTHORIZED, "unauthorized", "Unauthorized")
        }
    }
}

#[handler]
async fn lock(
    req: &Request,
    services: Data<&Services>,
    auth: Option<Data<&RequestAuthorization>>,
) -> poem::Result<Response> {
    require_admin(req, auth.as_ref()).await?;
    let Some(runtime) = runtime(services.0).await else {
        return Ok(error_response(
            StatusCode::CONFLICT,
            "encryption_disabled",
            "Encryption is disabled",
        ));
    };
    if !matches!(runtime.status().await, EncryptionStatus::Unlocked) {
        return Ok(error_response(
            StatusCode::CONFLICT,
            "invalid_state",
            "Invalid encryption state",
        ));
    }
    services.close_db().await;
    runtime.lock().await;
    audit_admin("encryption_lock", auth.as_ref());
    Ok(json_response(StatusCode::OK, &json!({"status": "locked"})))
}

#[handler]
async fn rekey_master(
    req: &Request,
    services: Data<&Services>,
    auth: Option<Data<&RequestAuthorization>>,
    Json(body): Json<RekeyMasterRequest>,
) -> poem::Result<Response> {
    require_admin(req, auth.as_ref()).await?;
    let Some(runtime) = runtime(services.0).await else {
        return Ok(error_response(
            StatusCode::CONFLICT,
            "encryption_disabled",
            "Encryption is disabled",
        ));
    };
    if !matches!(runtime.status().await, EncryptionStatus::Unlocked) {
        return Ok(error_response(
            StatusCode::CONFLICT,
            "invalid_state",
            "Invalid encryption state",
        ));
    }

    match runtime
        .rekey_master(
            SecretString::from(body.old_password),
            SecretString::from(body.new_password),
        )
        .await
    {
        Ok(()) => {
            audit_admin("encryption_rekey_master", auth.as_ref());
            Ok(json_response(
                StatusCode::OK,
                &json!({"status": "unlocked"}),
            ))
        }
        Err(error) => {
            warn!(target: "audit",%error, "encryption_rekey_master_failed");
            Ok(error_response(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Unauthorized",
            ))
        }
    }
}

async fn runtime(services: &Services) -> Option<Arc<gated_core::encryption::EncryptionRuntime>> {
    services.encryption_runtime.read().await.clone()
}

async fn open_unlocked_db(
    services: &Services,
    runtime: &gated_core::encryption::EncryptionRuntime,
) -> anyhow::Result<()> {
    let dek_hex = runtime
        .dek_hex()
        .ok_or_else(|| anyhow::anyhow!("encryption runtime is unlocked without a DEK"))?;
    services.open_db(&dek_hex).await
}

async fn require_admin(
    req: &Request,
    auth: Option<&Data<&RequestAuthorization>>,
) -> poem::Result<()> {
    let Some(auth) = auth else {
        return Err(poem::Error::from_status(StatusCode::UNAUTHORIZED));
    };
    if is_user_admin(req, auth).await? {
        Ok(())
    } else {
        Err(poem::Error::from_status(StatusCode::FORBIDDEN))
    }
}

async fn existing_sqlite_database(services: &Services) -> anyhow::Result<ExistingSqliteDatabase> {
    let config = services.config.read().await;
    let Some(path) = gated_core::db::sqlite_database_path(&config, &services.global_params)? else {
        return Ok(ExistingSqliteDatabase::Missing);
    };
    detect_existing_database(&path).await
}

async fn init_with_plaintext_migration(
    services: &Services,
    runtime: &gated_core::encryption::EncryptionRuntime,
    master_password: SecretString,
) -> anyhow::Result<Option<std::path::PathBuf>> {
    let config = services.config.read().await;
    let Some(path) = gated_core::db::sqlite_database_path(&config, &services.global_params)? else {
        anyhow::bail!("sqlite database path unavailable");
    };
    let report = runtime
        .init_with_plaintext_migration(
            master_password,
            &path,
            &MigrationOptions {
                auto_delete_plaintext: false,
                secure_files: services.global_params.should_secure_files(),
            },
        )
        .await?;
    Ok(report.backup_path)
}

async fn client_ip(req: &Request, services: &Services) -> Option<String> {
    get_client_ip(req, Some(services)).await
}

fn rate_limited(state: &EncryptionAdminState, client_ip: &Option<String>) -> bool {
    let key = client_ip.clone().unwrap_or_else(|| "<unknown>".to_owned());
    state.limiter.check_key(&key).is_err()
}

fn status_name(status: &EncryptionStatus) -> &'static str {
    match status {
        EncryptionStatus::Disabled => "disabled",
        EncryptionStatus::Uninitialized => "uninitialized",
        EncryptionStatus::Locked => "locked",
        EncryptionStatus::Unlocked => "unlocked",
        EncryptionStatus::Error(_) => "error",
    }
}

fn audit_failure(kind: &'static str, client_ip: Option<&str>, reason: &'static str) {
    warn!(target: "audit",kind, client_ip, reason, "encryption_admin_audit");
}

fn audit_admin(kind: &'static str, auth: Option<&Data<&RequestAuthorization>>) {
    let username = auth.and_then(|auth| auth.username()).map(String::as_str);
    info!(target: "audit",kind, username, "encryption_admin_audit");
}

fn json_response<T: Serialize>(status: StatusCode, body: &T) -> Response {
    let body = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(body)
}

fn error_response(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    let mut body = json!({
        "code": code,
        "message": message,
    });
    if status == StatusCode::TOO_MANY_REQUESTS {
        if let Some(object) = body.as_object_mut() {
            object.insert("retry_after".into(), json!(RETRY_AFTER_SECS));
        }
    }
    json_response(status, &body).into_response()
}

#[cfg(test)]
mod tests {
    use gated_common::{GatedConfig, GlobalParams, Secret};
    use gated_core::encryption::{BootstrapToken, EncryptionRuntime};
    use http::{Method, StatusCode};
    use poem::{Body, Endpoint, EndpointExt, IntoEndpoint, Request};
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use serde_json::{json, Value};
    use uuid::Uuid;

    use super::*;

    async fn test_services(name: &str) -> Services {
        let root =
            std::env::temp_dir().join(format!("gated-encryption-admin-{name}-{}", Uuid::new_v4()));
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
        let runtime = Arc::new(
            EncryptionRuntime::new(&root.join("data/encryption"))
                .await
                .expect("runtime"),
        );
        services.set_encryption_runtime(runtime).await;
        services
            .set_encryption_bootstrap_token(Some(BootstrapToken::from_token_for_tests(
                "bootstrap",
                None,
            )))
            .await;
        services
    }

    async fn send<E: Endpoint>(
        app: &E,
        method: Method,
        uri: &str,
        body: Option<Value>,
        auth: Option<RequestAuthorization>,
    ) -> Response {
        let mut req = Request::builder()
            .method(method)
            .uri(uri.parse().expect("valid uri"))
            .finish();
        if let Some(body) = body {
            req.headers_mut().insert(
                http::header::CONTENT_TYPE,
                http::HeaderValue::from_static("application/json"),
            );
            req.set_body(Body::from(serde_json::to_string(&body).expect("json body")));
        }
        if let Some(auth) = auth {
            req.extensions_mut().insert(auth);
        }
        app.get_response(req).await
    }

    async fn assert_json_body(response: Response, expected: Value) {
        let actual = response
            .into_body()
            .into_json::<Value>()
            .await
            .expect("json response");
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn init_lock_unlock_and_rekey_flow() {
        let services = test_services("flow").await;
        let app = routes().data(services.clone()).into_endpoint();

        let response = send(&app, Method::GET, "/lock-status", None, None).await;
        assert_json_body(
            response,
            json!({
                "status": "uninitialized",
                "db_ready": false,
                "retry_after": null,
            }),
        )
        .await;

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/init",
                Some(json!({
                    "bootstrap_token": "bootstrap",
                    "master_password": "old-password",
                })),
                None,
            )
            .await
            .status(),
            StatusCode::CREATED
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/init",
                Some(json!({
                    "bootstrap_token": "bootstrap",
                    "master_password": "old-password",
                })),
                None,
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/lock",
                None,
                Some(RequestAuthorization::AdminToken),
            )
            .await
            .status(),
            StatusCode::OK
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/unlock",
                Some(json!({
                    "master_password": "wrong-password",
                })),
                None,
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/unlock",
                Some(json!({
                    "master_password": "old-password",
                })),
                None,
            )
            .await
            .status(),
            StatusCode::OK
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/rekey-master",
                Some(json!({
                    "old_password": "old-password",
                    "new_password": "new-password",
                })),
                Some(RequestAuthorization::AdminToken),
            )
            .await
            .status(),
            StatusCode::OK
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/lock",
                None,
                Some(RequestAuthorization::AdminToken),
            )
            .await
            .status(),
            StatusCode::OK
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/unlock",
                Some(json!({
                    "master_password": "old-password",
                })),
                None,
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/unlock",
                Some(json!({
                    "master_password": "new-password",
                })),
                None,
            )
            .await
            .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn bad_bootstrap_token_is_forbidden_and_rate_limited() {
        let services = test_services("bad-bootstrap").await;
        let app = routes().data(services).into_endpoint();

        for _ in 0..5 {
            assert_eq!(
                send(
                    &app,
                    Method::POST,
                    "/init",
                    Some(json!({
                        "bootstrap_token": "wrong",
                        "master_password": "password",
                    })),
                    None,
                )
                .await
                .status(),
                StatusCode::FORBIDDEN
            );
        }

        assert_eq!(
            send(
                &app,
                Method::POST,
                "/init",
                Some(json!({
                    "bootstrap_token": "wrong",
                    "master_password": "password",
                })),
                None,
            )
            .await
            .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn init_migrates_existing_plaintext_sqlite_database() {
        let services = test_services("plaintext-migration").await;
        let db_path = {
            let config = services.config.read().await;
            gated_core::db::sqlite_database_path(&config, &services.global_params)
                .expect("sqlite path")
                .expect("sqlite database")
        };
        std::fs::create_dir_all(db_path.parent().expect("db parent")).expect("create db parent");
        let plaintext = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .expect("open plaintext fixture database");
        plaintext
            .execute_unprepared("CREATE TABLE fixture (id INTEGER PRIMARY KEY, name TEXT)")
            .await
            .expect("create fixture table");
        for idx in 0..10 {
            plaintext
                .execute_unprepared(&format!(
                    "INSERT INTO fixture (name) VALUES ('fixture-{idx}')"
                ))
                .await
                .expect("insert fixture row");
        }
        drop(plaintext);

        let app = routes().data(services.clone()).into_endpoint();
        let response = send(
            &app,
            Method::POST,
            "/init",
            Some(json!({
                "bootstrap_token": "bootstrap",
                "master_password": "migration-password",
            })),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let backup = db_path.with_file_name("db.sqlite3.plain.bak");
        assert_json_body(
            response,
            json!({"status": "unlocked", "plaintext_backup": backup.display().to_string()}),
        )
        .await;

        assert!(backup.exists());
        assert_eq!(
            gated_core::encryption::migration::detect_existing_database(&db_path)
                .await
                .expect("detect migrated database"),
            gated_core::encryption::migration::ExistingSqliteDatabase::EncryptedOrInvalid
        );

        let db = services.db_required().await.expect("unlocked db");
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS count FROM fixture".to_owned(),
            ))
            .await
            .expect("query fixture count")
            .expect("count row");
        let count: i64 = row.try_get("", "count").expect("count column");
        assert_eq!(count, 10);
    }
}
