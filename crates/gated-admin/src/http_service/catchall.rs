use axum::response::{IntoResponse, Redirect, Response};

pub fn target_select_redirect() -> Response {
    Redirect::temporary("/ui/").into_response()
}

/// Management-plane catchall: any path not claimed by `/api`, `/admin/api`,
/// or `/ui` redirects to the SPA. HTTP-reverse-proxy traffic is served by the dedicated
/// proxy listener in `gated-protocol-http::server`, not here.
pub async fn catchall_endpoint() -> Response {
    target_select_redirect()
}
