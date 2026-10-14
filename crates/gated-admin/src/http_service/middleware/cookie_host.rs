use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use cookie::Cookie;
use gated_common::web::server::ConnectionInfo;
use gated_core::Services;

use crate::http_service::common::{SESSION_COOKIE_NAME, is_localhost_host, request_host};

/// Validate a WebSocket request's `Origin` header to mitigate Cross-Site
/// WebSocket Hijacking (CSWSH). WS upgrades are exempt from CORS / the
/// Same-Origin Policy, so a browser will attach the session cookie to a
/// handshake initiated by an attacker page. We therefore explicitly require the
/// `Origin` host to match either the request's own host (same-origin) or the
/// configured external host (or one of its subdomains, for cross-subdomain SSO).
///
/// Returns `true` if the upgrade may proceed. A missing or unparseable `Origin`
/// is rejected.
pub(crate) async fn is_ws_origin_allowed(
    headers: &HeaderMap,
    uri: &http::Uri,
    services: &Services,
) -> bool {
    let Some(origin) = headers
        .get(http::header::ORIGIN)
        .and_then(|origin| origin.to_str().ok())
    else {
        return false;
    };
    let Some(origin_host) = origin
        .parse::<http::Uri>()
        .ok()
        .and_then(|u| u.host().map(str::to_owned))
    else {
        return false;
    };

    // Same-origin: the Origin host equals the request's own Host. Covers direct
    // access and local development without any configuration.
    let request_host = request_host(headers, uri);
    if request_host.as_deref() == Some(origin_host.as_str()) {
        return true;
    }

    // Otherwise the Origin must match the configured external host (or one of
    // its subdomains). Reuse the same configured-host source as the Host-binding
    // check in `common.rs`.
    let config = services.config.read().await;
    let base_host = config
        .store
        .http
        .cookie_domain
        .as_deref()
        .map(|d| d.strip_prefix('.').unwrap_or(d).to_string())
        .or_else(|| {
            config
                .construct_external_url(None, None)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
        });

    match base_host {
        Some(base) => origin_host == base || origin_host.ends_with(&format!(".{base}")),
        None => false,
    }
}

#[derive(Clone)]
pub struct CookieHostMiddleware {
    base_domain: Option<String>,
}

impl CookieHostMiddleware {
    /// If `base_domain` is Some(".example.com"), the session cookie will be
    /// scoped to that domain (works across subdomains). If None, it falls
    /// back to the request host (previous behavior).
    pub fn new(base_domain: Option<String>) -> Self {
        Self { base_domain }
    }
}

/// Scopes the session cookie to the configured domain and hardens it on
/// HTTPS.
pub async fn cookie_host_middleware(
    State(middleware): State<CookieHostMiddleware>,
    request: Request,
    next: Next,
) -> Response {
    let host = request_host(request.headers(), request.uri());

    let scheme_https = request
        .extensions()
        .get::<ConnectionInfo>()
        .is_some_and(|info| info.tls);
    let header_https = request
        .headers()
        .get("x-forwarded-proto")
        .map(|h| h == "https")
        .unwrap_or(false);
    let is_https = scheme_https || header_https;

    let mut resp = next.run(request).await;

    if let Some(host) = host {
        // Extract all Set-Cookie headers for modification
        let cookie_values: Vec<String> = {
            let headers = resp.headers();
            headers
                .get_all(http::header::SET_COOKIE)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .collect()
        };

        // Use the cookie crate to parse and modify cookies properly
        let mut modified_session_cookie: Option<String> = None;
        for cookie_str in &cookie_values {
            if let Ok(mut cookie) = Cookie::parse(cookie_str)
                && cookie.name() == SESSION_COOKIE_NAME
            {
                // For localhost/127.0.0.1, omit Domain attribute since browsers won't send cookies with a different domain
                let is_localhost = is_localhost_host(&host);
                let target_domain = if is_localhost {
                    None // Omit Domain attribute for localhost - browser will scope to exact host
                } else if let Some(ref base) = middleware.base_domain {
                    Some(base.clone())
                } else {
                    Some(host.clone())
                };

                // Set or remove Domain attribute using cookie crate methods
                if let Some(ref domain) = target_domain {
                    cookie.set_domain(domain.clone());
                } else {
                    // For localhost, we need to remove the domain attribute
                    cookie.unset_domain();
                }

                // On HTTPS mark the cookie Secure and SameSite=Lax. Lax
                // still travels across subdomains of the same site (so
                // cross-subdomain SSO keeps working) but is NOT attached
                // to cross-site WebSocket handshakes, which is the
                // primary CSWSH mitigation. The Origin allowlist
                // (`is_ws_origin_allowed`) is the defense-in-depth check.
                if is_https {
                    cookie.set_secure(true);
                    cookie.set_same_site(cookie::SameSite::Lax);
                }

                if middleware.base_domain.is_none() {
                    tracing::warn!(
                        "CookieHostMiddleware: Setting session cookie domain to request host: {} (no base domain configured). This may prevent SSO from working across subdomains. Consider setting 'external_host' in config.",
                        host
                    );
                }

                modified_session_cookie = Some(cookie.to_string());
                tracing::debug!(
                    "CookieHostMiddleware: Modified cookie - domain={:?}, is_https={}",
                    target_domain,
                    is_https
                );
                break;
            }
        }

        if modified_session_cookie.is_none() {
            tracing::debug!(
                "CookieHostMiddleware: No session cookie found in {} cookie(s)",
                cookie_values.len()
            );
        }

        // Replace Set-Cookie headers: modified session cookie + other cookies unchanged
        if let Some(modified_cookie) = modified_session_cookie {
            let headers = resp.headers_mut();
            headers.remove(http::header::SET_COOKIE);
            if let Ok(header_value) = modified_cookie.parse::<http::HeaderValue>() {
                headers.append(http::header::SET_COOKIE, header_value);
            }
            for cookie_str in &cookie_values {
                if let Ok(cookie) = Cookie::parse(cookie_str)
                    && cookie.name() != SESSION_COOKIE_NAME
                    && let Ok(header_value) = cookie_str.parse::<http::HeaderValue>()
                {
                    headers.append(http::header::SET_COOKIE, header_value);
                }
            }
        }
    }
    resp
}
