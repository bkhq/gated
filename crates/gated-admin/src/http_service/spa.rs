use axum::Router;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use gated_web::Assets;

/// Routes serving the web UI under `/ui`.
pub fn routes() -> Router {
    // A nested router does not match its own path with a trailing slash.
    Router::new()
        .route("/ui/", any(spa_endpoint))
        .nest("/ui", Router::new().fallback(spa_endpoint))
}

/// Serves embedded static files with SPA fallback.
/// Tries to serve the requested file; if not found, returns `index.html`.
pub async fn spa_endpoint(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    if let Some(resp) = serve_file(path) {
        return resp;
    }

    // SPA fallback: serve index.html
    match Assets::get("index.html") {
        Some(file) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            file.data.to_vec(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn serve_file(path: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    Some(
        (
            [
                (header::CONTENT_TYPE, content_type(path)),
                (header::CACHE_CONTROL, cache_control(path)),
            ],
            file.data.to_vec(),
        )
            .into_response(),
    )
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

fn cache_control(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn every_path_below_the_mount_point_reaches_the_spa() {
        let app = Router::new()
            .merge(routes())
            .fallback(|| async { StatusCode::IM_A_TEAPOT });
        let expected = spa_endpoint(Uri::from_static("/")).await.status();

        for path in ["/ui", "/ui/", "/ui/auth/login", "/ui/?gated-ticket=x"] {
            let request = Request::builder().uri(path).body(Body::empty()).unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected, "{path}");
        }
    }
}
