use gated_core::SessionHandle;

/// Session handle for API proxy requests.
///
/// API proxy sessions are short-lived (one request each) and have no persistent
/// connection to close.  Cleanup is handled by `GatedServerHandle::drop`,
/// which calls `State::remove_session` when the handle is dropped at the end
/// of `proxy_api_request`.
pub struct ApiSessionHandle;

impl SessionHandle for ApiSessionHandle {
    fn close(&mut self) {
        // No-op: API sessions have no persistent connection to tear down.
        // Session lifecycle is managed via GatedServerHandle::drop.
    }
}
