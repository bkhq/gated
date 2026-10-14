use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use gated_core::encryption::{EncryptionRuntime, EncryptionStatus};
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

fn locked_response(status: StatusCode) -> Response {
    let body = json!({
        "code": "db_locked",
        "message": "Database is locked. Unlock via /api/admin/encryption/unlock",
    });
    (
        status,
        [(CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// Answers every request outside the allowlist with an error while the
/// database is locked.
pub async fn db_lock_middleware(
    State(middleware): State<DbLockMiddleware>,
    request: Request,
    next: Next,
) -> Response {
    if middleware.is_allowlisted(request.uri().path()) {
        return next.run(request).await;
    }

    let Some(runtime) = &middleware.runtime else {
        return next.run(request).await;
    };

    match runtime.status().await {
        EncryptionStatus::Locked | EncryptionStatus::Uninitialized => {
            locked_response(StatusCode::LOCKED)
        }
        EncryptionStatus::Error(_) => locked_response(StatusCode::SERVICE_UNAVAILABLE),
        EncryptionStatus::Disabled | EncryptionStatus::Unlocked => next.run(request).await,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use gated_core::encryption::EncryptionRuntime;
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::{DbLockMiddleware, db_lock_middleware};

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("gated-db-lock-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    async fn status_of(
        runtime: EncryptionRuntime,
        allowlist: Vec<String>,
        uri: &str,
    ) -> StatusCode {
        let middleware = DbLockMiddleware::new(Some(Arc::new(runtime)), allowlist);
        let app = Router::new().fallback(get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state(middleware, db_lock_middleware),
        );
        let request = Request::builder().uri(uri).body(Body::empty()).unwrap();
        app.oneshot(request).await.unwrap().status()
    }

    #[tokio::test]
    async fn locked_runtime_rejects_non_allowlisted_request() {
        let runtime = EncryptionRuntime::new(&temp_dir("locked")).await.unwrap();
        assert_eq!(
            status_of(runtime, vec![], "/private").await,
            StatusCode::LOCKED
        );
    }

    #[tokio::test]
    async fn locked_runtime_allows_allowlisted_request() {
        let runtime = EncryptionRuntime::new(&temp_dir("allowlisted"))
            .await
            .unwrap();
        assert_eq!(
            status_of(runtime, vec!["/healthz".to_owned()], "/healthz").await,
            StatusCode::OK
        );
    }
}
