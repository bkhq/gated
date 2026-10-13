use std::sync::Arc;

use gated_core::encryption::{EncryptionRuntime, EncryptionStatus};
use http::StatusCode;
use poem::http::header::CONTENT_TYPE;
use poem::{Endpoint, IntoResponse, Middleware, Request, Response};
use serde_json::json;

#[derive(Clone)]
pub struct DbLockMiddleware {
    runtime: Option<Arc<EncryptionRuntime>>,
    allowlist: Arc<Vec<String>>,
}

impl DbLockMiddleware {
    pub fn new(runtime: Option<Arc<EncryptionRuntime>>, allowlist: Vec<String>) -> Self {
        Self {
            runtime,
            allowlist: Arc::new(allowlist),
        }
    }

    fn is_allowlisted(&self, path: &str) -> bool {
        self.allowlist.iter().any(|prefix| path.starts_with(prefix))
    }
}

pub struct DbLockEndpoint<E> {
    inner: E,
    middleware: DbLockMiddleware,
}

impl<E: Endpoint> Middleware<E> for DbLockMiddleware {
    type Output = DbLockEndpoint<E>;

    fn transform(&self, inner: E) -> Self::Output {
        DbLockEndpoint {
            inner,
            middleware: self.clone(),
        }
    }
}

impl<E: Endpoint> Endpoint for DbLockEndpoint<E> {
    type Output = Response;

    async fn call(&self, req: Request) -> poem::Result<Self::Output> {
        if self.middleware.is_allowlisted(req.uri().path()) {
            return Ok(self.inner.call(req).await?.into_response());
        }

        let Some(runtime) = &self.middleware.runtime else {
            return Ok(self.inner.call(req).await?.into_response());
        };

        match runtime.status().await {
            EncryptionStatus::Locked | EncryptionStatus::Uninitialized => {
                let body = json!({
                    "code": "db_locked",
                    "message": "Database is locked. Unlock via /api/admin/encryption/unlock",
                });
                Ok(Response::builder()
                    .status(StatusCode::LOCKED)
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.to_string()))
            }
            EncryptionStatus::Error(_) => {
                let body = json!({
                    "code": "db_locked",
                    "message": "Database is locked. Unlock via /api/admin/encryption/unlock",
                });
                Ok(Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.to_string()))
            }
            EncryptionStatus::Disabled | EncryptionStatus::Unlocked => {
                Ok(self.inner.call(req).await?.into_response())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use gated_core::encryption::EncryptionRuntime;
    use poem::http::StatusCode;
    use poem::{Endpoint, Middleware, Request, Response};
    use uuid::Uuid;

    use super::DbLockMiddleware;

    struct OkEndpoint;

    impl Endpoint for OkEndpoint {
        type Output = Response;

        async fn call(&self, _req: Request) -> poem::Result<Self::Output> {
            Ok(Response::builder().status(StatusCode::OK).body("ok"))
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("gated-db-lock-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn locked_runtime_rejects_non_allowlisted_request() {
        let runtime = EncryptionRuntime::new(&temp_dir("locked")).await.unwrap();
        let endpoint = DbLockMiddleware::new(Some(Arc::new(runtime)), vec![]).transform(OkEndpoint);
        let req = Request::builder().uri("/private".parse().unwrap()).finish();

        let response = endpoint.call(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::LOCKED);
    }

    #[tokio::test]
    async fn locked_runtime_allows_allowlisted_request() {
        let runtime = EncryptionRuntime::new(&temp_dir("allowlisted"))
            .await
            .unwrap();
        let endpoint = DbLockMiddleware::new(Some(Arc::new(runtime)), vec!["/healthz".to_owned()])
            .transform(OkEndpoint);
        let req = Request::builder().uri("/healthz".parse().unwrap()).finish();

        let response = endpoint.call(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
