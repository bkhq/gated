use std::collections::HashSet;

use axum::http::{self, HeaderName};
use std::sync::LazyLock;

/// Headers that should not be forwarded to upstream when proxying HTTP requests
pub static DONT_FORWARD_HEADERS: LazyLock<HashSet<HeaderName>> = LazyLock::new(|| {
    #[allow(clippy::mutable_key_type)]
    let mut s = HashSet::new();
    s.insert(http::header::ACCEPT_ENCODING);
    s.insert(http::header::SEC_WEBSOCKET_EXTENSIONS);
    s.insert(http::header::SEC_WEBSOCKET_ACCEPT);
    s.insert(http::header::SEC_WEBSOCKET_KEY);
    s.insert(http::header::SEC_WEBSOCKET_VERSION);
    s.insert(http::header::UPGRADE);
    s.insert(http::header::HOST);
    s.insert(http::header::CONNECTION);
    s.insert(http::header::STRICT_TRANSPORT_SECURITY);
    s.insert(http::header::UPGRADE_INSECURE_REQUESTS);
    // Never forward client-supplied forwarding/identity headers
    // upstream. `Host` (above) is already replaced with the correct upstream
    // host by reqwest. `Cookie` would leak the bastion session cookie to the
    // target. The `X-Forwarded-*` / `Forwarded` family is attacker-controlled
    // and must not be trusted by the upstream as if gated had set it.
    s.insert(http::header::COOKIE);
    s.insert(http::header::FORWARDED);
    s.insert(X_FORWARDED_FOR.clone());
    s.insert(X_FORWARDED_HOST.clone());
    s.insert(X_FORWARDED_PROTO.clone());
    s
});

pub static X_FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");
pub static X_FORWARDED_HOST: HeaderName = HeaderName::from_static("x-forwarded-host");
pub static X_FORWARDED_PROTO: HeaderName = HeaderName::from_static("x-forwarded-proto");

pub static X_GATED_TARGET: HeaderName = HeaderName::from_static("x-gated-target");
pub static X_GATED_TOKEN: HeaderName = HeaderName::from_static("x-gated-token");

/// Maximum request body size for API proxy requests (100 MB)
pub const API_PROXY_MAX_BODY_SIZE: usize = 100 * 1024 * 1024;

/// Query parameters that carry a credential and must never reach a log:
/// `gated-token` is an API token, `gated-ticket` a ticket secret
/// accepted on the `/api` plane.
pub static SECRET_QUERY_PARAMS: [&str; 2] = ["gated-token", "gated-ticket"];

/// Remove every credential-bearing query parameter from a URI so the secret
/// riding in it never reaches request logs. The original (unscrubbed) URI is
/// still used for routing and authentication; only the logged copy is
/// sanitized.
pub fn scrub_secret_query_params(uri: &http::Uri) -> http::Uri {
    let Some(query) = uri.query() else {
        return uri.clone();
    };
    let is_secret = |pair: &str| {
        SECRET_QUERY_PARAMS
            .iter()
            .any(|name| pair.starts_with(name) && pair.as_bytes().get(name.len()) == Some(&b'='))
    };
    if !query.split('&').any(is_secret) {
        return uri.clone();
    }
    let filtered = query
        .split('&')
        .filter(|pair| !is_secret(pair))
        .collect::<Vec<_>>()
        .join("&");
    let path = uri.path();
    let rebuilt = if filtered.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{filtered}")
    };
    // Fall back to a query-less, secret-free URI if reconstruction somehow
    // fails, so a parse error can never leak the secret into logs.
    rebuilt
        .parse::<http::Uri>()
        .or_else(|_| path.parse::<http::Uri>())
        .unwrap_or_else(|_| http::Uri::from_static("/"))
}
