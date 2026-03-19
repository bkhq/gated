use std::sync::Arc;

use poem::{Body, Request, Response};
use tokio::sync::Mutex;
use gated_common::{TargetApiOptions, GatedError};
use gated_core::logging::http::get_client_ip;
use gated_core::{Services, SessionStateInit, State, GatedServerHandle};
use gated_protocol_api::proxy::proxy_to_upstream;
use gated_protocol_api::session_handle::ApiSessionHandle;

/// Handle a complete API proxy request lifecycle: register session, proxy, close session.
///
/// The `GatedServerHandle` is kept alive for the duration of the proxy request
/// and dropped afterward, which triggers `remove_session` via its `Drop` impl.
pub async fn proxy_api_request(
    req: &Request,
    body: Body,
    api_options: &TargetApiOptions,
    username: &str,
    services: &Services,
) -> Result<Response, GatedError> {
    let path = req.uri().path();

    // Register session — the handle must live until the proxy completes.
    let handle = register_api_session(req, services).await?;
    let session_id = handle.lock().await.id();

    let result = proxy_to_upstream(
        req,
        body,
        api_options,
        path,
        username,
        session_id,
        services,
        &services.recordings,
    )
    .await;

    // `handle` is dropped here, triggering GatedServerHandle::drop
    // which calls state.remove_session(id) to properly close the session.
    drop(handle);

    result
}

/// Register a new session for an API proxy request.
/// Returns the server handle — caller must keep it alive for the session's duration.
async fn register_api_session(
    req: &Request,
    services: &Services,
) -> Result<Arc<Mutex<GatedServerHandle>>, GatedError> {
    let ip = get_client_ip(req, Some(services)).await;

    State::register_session(
        &services.state,
        &gated_protocol_api::PROTOCOL_NAME,
        SessionStateInit {
            remote_address: ip.and_then(|x| x.parse().ok()),
            handle: Box::new(ApiSessionHandle),
        },
    )
    .await
}
