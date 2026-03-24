use poem::http::{header, StatusCode};
use poem::{Endpoint, Request, Response, Result};
use gated_web::Assets;

/// Serves embedded static files with SPA fallback.
/// Tries to serve the requested file; if not found, returns `index.html`.
pub struct SpaEndpoint;

impl SpaEndpoint {
    pub fn new() -> Self {
        Self
    }
}

impl Endpoint for SpaEndpoint {
    type Output = Response;

    async fn call(&self, req: Request) -> Result<Self::Output> {
        let path = req.uri().path().trim_start_matches('/');

        if let Some(resp) = serve_file(path) {
            return Ok(resp);
        }

        // SPA fallback: serve index.html
        match Assets::get("index.html") {
            Some(file) => Ok(Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(file.data.to_vec())),
            None => Ok(Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body("not found")),
        }
    }
}

fn serve_file(path: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(path))
            .header(header::CACHE_CONTROL, cache_control(path))
            .body(file.data.to_vec()),
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
