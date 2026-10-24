//! Target resolution for the HTTP-proxy listener.
//!
//! Two routing modes are evaluated in order on each incoming request:
//!
//! 1. **`X-Gated-Target: <name>` header** — explicit override; bypasses Host
//!    parsing entirely.  Required for clients that can't use DNS wildcards
//!    (curl scripts, sandboxes, internal mesh).
//! 2. **Host header `<label>.<base_domain>`** — fallback when no header.
//!    `<label>` becomes the target name.
//!
//! If neither resolves, the listener returns **401 Unauthorized** with a
//! fixed body and no `WWW-Authenticate` challenge — the response shape
//! deliberately collapses "target not found" and "unauthenticated" so the
//! proxy does not leak which target names exist.

use axum::http::request::Parts;
use gated_common::Target;
use gated_core::{ConfigProvider, Services};
use thiserror::Error;

const X_GATED_TARGET_HEADER: &str = "x-gated-target";

/// Maximum length of a single DNS label per RFC 1035.
const MAX_DNS_LABEL_LEN: usize = 63;

/// Why target resolution failed.  All variants map to 401 at the listener,
/// but the variant is preserved for structured logging.
#[derive(Debug, Error)]
pub enum ResolveError {
    #[error("target not identified: provide X-Gated-Target header or Host: <target>.<base_domain>")]
    NotIdentified,
    #[error("target '{name}' not found")]
    NotFound { name: String },
    #[error(
        "invalid target name '{name}' (must be a valid DNS label: lowercase a-z0-9 plus hyphen, 1–63 chars, no leading/trailing hyphen)"
    )]
    InvalidName { name: String },
    #[error("listing targets: {0}")]
    ListTargets(#[source] anyhow::Error),
}

#[derive(Debug, Clone)]
pub struct ResolverConfig {
    /// Wildcard base domain — e.g. `proxy.example.com`.  Host values shaped
    /// `<label>.<base_domain>` resolve to `<label>` as the target name.
    pub base_domain: String,
}

/// Locate the target name implied by the request, without doing any IO.
///
/// Returns `Ok(name)` if the request carries either a valid `X-Gated-Target`
/// header or a Host header matching `<label>.<base_domain>`.  Returns
/// `Err(NotIdentified)` if neither is present, or `Err(InvalidName)` if the
/// extracted name is not a valid DNS label.
pub fn target_name_from_request(
    req: &Parts,
    config: &ResolverConfig,
) -> Result<String, ResolveError> {
    if let Some(header_value) = req
        .headers
        .get(X_GATED_TARGET_HEADER)
        .and_then(|v| v.to_str().ok())
    {
        let name = header_value.trim();
        if name.is_empty() {
            return Err(ResolveError::NotIdentified);
        }
        if !is_valid_dns_label(name) {
            return Err(ResolveError::InvalidName {
                name: name.to_string(),
            });
        }
        return Ok(name.to_string());
    }

    if let Some(host) = req
        .headers
        .get(http::header::HOST)
        .and_then(|v| v.to_str().ok())
        && let Some(label) = parse_host_label(host, &config.base_domain)
    {
        if !is_valid_dns_label(&label) {
            return Err(ResolveError::InvalidName { name: label });
        }
        return Ok(label);
    }

    Err(ResolveError::NotIdentified)
}

/// Resolve the request to a `Target`, performing IO against the config
/// provider.  Combines [`target_name_from_request`] with a lookup.
pub async fn resolve_target(
    req: &Parts,
    config: &ResolverConfig,
    services: &Services,
) -> Result<Target, ResolveError> {
    let name = target_name_from_request(req, config)?;
    let mut cp = services.config_provider.lock().await;
    let targets = cp
        .list_targets()
        .await
        .map_err(|e| ResolveError::ListTargets(anyhow::anyhow!(e)))?;
    for target in targets {
        if target.name == name {
            return Ok(target);
        }
    }
    Err(ResolveError::NotFound { name })
}

/// Extract the leading label of `host` if `host` shapes as
/// `<label>.<base_domain>` (case-insensitive, with optional `:port` and
/// trailing `.`).  Returns `None` for IPv6 literal hosts, for hosts that
/// don't end in `.<base_domain>`, and for hosts where the would-be label
/// contains another dot (i.e. `<sub.label>.<base_domain>` is not a match —
/// only a single label is honoured).
pub fn parse_host_label(host: &str, base_domain: &str) -> Option<String> {
    let host = host.to_ascii_lowercase();
    let base_domain = base_domain.to_ascii_lowercase();

    // IPv6 literal: `[::1]` or `[::1]:36443` — cannot match a labelled host.
    if host.starts_with('[') {
        return None;
    }

    // Strip optional `:port` (the trailing colon group, IPv4 + name only).
    let host_no_port = match host.find(':') {
        Some(i) => &host[..i],
        None => host.as_str(),
    };
    // Tolerate the FQDN trailing dot.
    let host_no_port = host_no_port.trim_end_matches('.');

    let suffix = format!(".{}", base_domain.trim_end_matches('.'));
    if !host_no_port.ends_with(&suffix) {
        return None;
    }
    let label = &host_no_port[..host_no_port.len() - suffix.len()];
    if label.is_empty() || label.contains('.') {
        return None;
    }
    Some(label.to_string())
}

/// Validate a target name per RFC 1035 DNS label rules, lowercase-only:
/// `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
pub fn is_valid_dns_label(s: &str) -> bool {
    if s.is_empty() || s.len() > MAX_DNS_LABEL_LEN {
        return false;
    }
    let bytes = s.as_bytes();
    if !bytes.first().is_some_and(|b| is_label_alnum(*b))
        || !bytes.last().is_some_and(|b| is_label_alnum(*b))
    {
        return false;
    }
    for &b in bytes {
        if !(is_label_alnum(b) || b == b'-') {
            return false;
        }
    }
    true
}

fn is_label_alnum(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req_with_headers(pairs: &[(&str, &str)]) -> Parts {
        let mut builder = http::Request::builder();
        for (name, value) in pairs {
            builder = builder.header(*name, *value);
        }
        builder.body(()).unwrap().into_parts().0
    }

    fn cfg() -> ResolverConfig {
        ResolverConfig {
            base_domain: "proxy.example.com".into(),
        }
    }

    // ---- parse_host_label ----

    #[test]
    fn parse_host_basic() {
        assert_eq!(
            parse_host_label("foo.proxy.example.com", "proxy.example.com"),
            Some("foo".into())
        );
    }

    #[test]
    fn parse_host_with_port() {
        assert_eq!(
            parse_host_label("foo.proxy.example.com:36443", "proxy.example.com"),
            Some("foo".into())
        );
    }

    #[test]
    fn parse_host_trailing_dot() {
        assert_eq!(
            parse_host_label("foo.proxy.example.com.", "proxy.example.com"),
            Some("foo".into())
        );
    }

    #[test]
    fn parse_host_mixed_case() {
        assert_eq!(
            parse_host_label("FOO.Proxy.Example.COM", "proxy.example.com"),
            Some("foo".into())
        );
    }

    #[test]
    fn parse_host_no_label() {
        // Bare base domain — no leading label.
        assert_eq!(
            parse_host_label("proxy.example.com", "proxy.example.com"),
            None
        );
    }

    #[test]
    fn parse_host_multi_label_rejected() {
        assert_eq!(
            parse_host_label("a.b.proxy.example.com", "proxy.example.com"),
            None
        );
    }

    #[test]
    fn parse_host_wrong_suffix() {
        assert_eq!(
            parse_host_label("foo.other.example.com", "proxy.example.com"),
            None
        );
    }

    #[test]
    fn parse_host_ipv6_rejected() {
        assert_eq!(parse_host_label("[::1]:36443", "proxy.example.com"), None);
        assert_eq!(parse_host_label("[::1]", "proxy.example.com"), None);
    }

    // ---- is_valid_dns_label ----

    #[test]
    fn dns_label_accepts_simple() {
        assert!(is_valid_dns_label("foo"));
        assert!(is_valid_dns_label("foo-bar"));
        assert!(is_valid_dns_label("k8s-prod-01"));
        assert!(is_valid_dns_label("a"));
        assert!(is_valid_dns_label("a1"));
        assert!(is_valid_dns_label("1a")); // RFC 1123 relaxation
    }

    #[test]
    fn dns_label_rejects_invalid() {
        assert!(!is_valid_dns_label(""));
        assert!(!is_valid_dns_label("Foo")); // uppercase
        assert!(!is_valid_dns_label("-foo")); // leading hyphen
        assert!(!is_valid_dns_label("foo-")); // trailing hyphen
        assert!(!is_valid_dns_label("foo.bar")); // dot
        assert!(!is_valid_dns_label("foo_bar")); // underscore
        assert!(!is_valid_dns_label(&"a".repeat(64))); // too long
    }

    #[test]
    fn dns_label_accepts_63_chars() {
        assert!(is_valid_dns_label(&"a".repeat(63)));
    }

    // ---- target_name_from_request ----

    #[test]
    fn header_wins_over_host() {
        let req = req_with_headers(&[
            ("X-Gated-Target", "from-header"),
            ("Host", "from-host.proxy.example.com"),
        ]);
        assert_eq!(
            target_name_from_request(&req, &cfg()).unwrap(),
            "from-header"
        );
    }

    #[test]
    fn falls_back_to_host_when_no_header() {
        let req = req_with_headers(&[("Host", "from-host.proxy.example.com:36443")]);
        assert_eq!(target_name_from_request(&req, &cfg()).unwrap(), "from-host");
    }

    #[test]
    fn invalid_header_name() {
        let req = req_with_headers(&[("X-Gated-Target", "BadName")]);
        assert!(matches!(
            target_name_from_request(&req, &cfg()),
            Err(ResolveError::InvalidName { .. })
        ));
    }

    #[test]
    fn empty_header_is_not_identified() {
        let req = req_with_headers(&[("X-Gated-Target", "   ")]);
        assert!(matches!(
            target_name_from_request(&req, &cfg()),
            Err(ResolveError::NotIdentified)
        ));
    }

    #[test]
    fn no_header_no_host_is_not_identified() {
        let req = req_with_headers(&[]);
        assert!(matches!(
            target_name_from_request(&req, &cfg()),
            Err(ResolveError::NotIdentified)
        ));
    }

    #[test]
    fn host_does_not_match_base_domain() {
        let req = req_with_headers(&[("Host", "elsewhere.example.org")]);
        assert!(matches!(
            target_name_from_request(&req, &cfg()),
            Err(ResolveError::NotIdentified)
        ));
    }

    #[test]
    fn host_label_is_invalid_dns() {
        // valid syntactically as a host label (has lowercase letters and
        // dashes), but contains a dot in front — multi-label, should be
        // rejected by parse_host_label, then NotIdentified.
        let req = req_with_headers(&[("Host", "a.b.proxy.example.com")]);
        assert!(matches!(
            target_name_from_request(&req, &cfg()),
            Err(ResolveError::NotIdentified)
        ));
    }
}
