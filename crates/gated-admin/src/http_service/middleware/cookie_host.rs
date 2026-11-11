use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use cookie::Cookie;
use gated_common::web::server::ConnectionInfo;
use gated_core::Services;

use crate::http_service::common::{
    RequestAuthorization, SESSION_COOKIE_NAME, is_localhost_host, request_host,
};

/// Whether a browser page served from `origin_host` may open a
/// cookie-authenticated WebSocket: the request's own host, the external host,
/// or a subdomain of an explicitly configured cookie domain. Hosts of proxied
/// HTTP targets (`<label>.<proxy_base_domain>`) are never trusted.
fn origin_host_allowed(
    origin_host: &str,
    request_host: Option<&str>,
    external_host: Option<&str>,
    cookie_domain: Option<&str>,
    proxy_base_domain: &str,
) -> bool {
    let origin_host = origin_host.to_ascii_lowercase();
    let proxy_base_domain = proxy_base_domain.trim_matches('.').to_ascii_lowercase();
    if !proxy_base_domain.is_empty() && origin_host.ends_with(&format!(".{proxy_base_domain}")) {
        return false;
    }
    if request_host.is_some_and(|host| host.eq_ignore_ascii_case(&origin_host))
        || external_host.is_some_and(|host| host.eq_ignore_ascii_case(&origin_host))
    {
        return true;
    }
    cookie_domain.is_some_and(|domain| {
        let domain = domain.trim_matches('.').to_ascii_lowercase();
        !domain.is_empty()
            && (origin_host == domain || origin_host.ends_with(&format!(".{domain}")))
    })
}

/// A missing or unparseable `Origin` is rejected.
async fn is_ws_origin_allowed(headers: &HeaderMap, uri: &http::Uri, services: &Services) -> bool {
    let Some(origin_host) = headers
        .get(http::header::ORIGIN)
        .and_then(|origin| origin.to_str().ok())
        .and_then(|origin| origin.parse::<http::Uri>().ok())
        .and_then(|origin| origin.host().map(str::to_owned))
    else {
        return false;
    };
    let request_host = request_host(headers, uri);
    let config = services.config.read().await;
    let external_host = config
        .construct_external_url(None, None)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned));
    origin_host_allowed(
        &origin_host,
        request_host.as_deref(),
        external_host.as_deref(),
        config.store.admin.cookie_domain.as_deref(),
        &config.store.http.base_domain,
    )
}

/// Refuses a WebSocket upgrade that rides on a session cookie unless its
/// `Origin` is trusted: browsers attach the cookie to cross-site handshakes.
pub async fn ws_origin_guard(request: Request, next: Next) -> Response {
    let is_upgrade = request
        .headers()
        .get(http::header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let is_session = matches!(
        request.extensions().get::<RequestAuthorization>(),
        Some(RequestAuthorization::Session(_))
    );
    if is_upgrade && is_session {
        let Some(services) = request.extensions().get::<Services>().cloned() else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        if !is_ws_origin_allowed(request.headers(), request.uri(), &services).await {
            tracing::warn!(target: "audit", path = %request.uri().path(), "websocket_origin_rejected");
            return (StatusCode::FORBIDDEN, "Invalid Origin").into_response();
        }
    }
    next.run(request).await
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

#[cfg(test)]
mod tests {
    use super::origin_host_allowed;

    #[test]
    fn same_host_and_external_host_are_trusted() {
        assert!(origin_host_allowed(
            "gw.example.com",
            Some("gw.example.com"),
            None,
            None,
            ""
        ));
        assert!(origin_host_allowed(
            "GW.example.com",
            Some("10.0.0.1"),
            Some("gw.example.com"),
            None,
            ""
        ));
        assert!(!origin_host_allowed(
            "evil.example",
            Some("gw.example.com"),
            Some("gw.example.com"),
            None,
            ""
        ));
    }

    #[test]
    fn a_subdomain_is_trusted_only_under_a_configured_cookie_domain() {
        let ext = Some("gw.example.com");
        assert!(!origin_host_allowed(
            "app.gw.example.com",
            ext,
            ext,
            None,
            ""
        ));
        assert!(origin_host_allowed(
            "sso.example.com",
            ext,
            ext,
            Some(".example.com"),
            ""
        ));
        assert!(!origin_host_allowed(
            "badexample.com",
            ext,
            ext,
            Some(".example.com"),
            ""
        ));
    }

    #[test]
    fn proxied_target_hosts_are_never_trusted() {
        let ext = Some("gw.example.com");
        for origin in ["app.proxy.example.com", "app.gw.example.com"] {
            let base = origin
                .split_once('.')
                .map(|(_, base)| base)
                .unwrap_or_default();
            assert!(!origin_host_allowed(
                origin,
                ext,
                ext,
                Some(".example.com"),
                base
            ));
            assert!(!origin_host_allowed(origin, Some(origin), ext, None, base));
        }
        assert!(origin_host_allowed(
            "gw.example.com",
            ext,
            ext,
            None,
            "gw.example.com"
        ));
    }
}
