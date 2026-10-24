use std::fmt::Debug;

use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use gated_common::web::server::ConnectionInfo;
use tracing::*;

use crate::{GatedServerHandle, Services};

/// Neutralize control characters in an untrusted value before it is recorded
/// into a tracing span/event field.
///
/// The default text log sink (`LogFormat::Text`) writes field values via
/// `Display` with no escaping, so attacker-controlled headers/URLs containing
/// CR/LF could inject forged log lines and ANSI escape sequences (`ESC`) could
/// execute in an admin's terminal. This backslash-escapes CR/LF/TAB and any
/// other ASCII control character (including `ESC`, which starts ANSI
/// sequences) so both text and JSON sinks receive clean values.
fn sanitize_log_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

pub async fn get_client_ip(parts: &Parts, services: Option<&Services>) -> Option<String> {
    let trust_x_forwarded_headers = if let Some(services) = services {
        let config = services.config.read().await;
        config.store.admin.trust_x_forwarded_headers
    } else {
        false
    };

    let remote_ip = parts
        .extensions
        .get::<ConnectionInfo>()
        .map(|info| info.remote_addr.ip().to_string());

    if trust_x_forwarded_headers {
        header(&parts.headers, "x-forwarded-for")
            .map(|x| x.to_string())
            .or(remote_ip)
    } else {
        remote_ip
    }
}

pub async fn span_for_request(parts: &Parts, handle: Option<&GatedServerHandle>) -> Span {
    let services = parts.extensions.get::<Services>();
    let client_ip = get_client_ip(parts, services)
        .await
        .unwrap_or("<unknown>".into());
    let user_agent = sanitize_log_value(header(&parts.headers, "user-agent").unwrap_or("-"));
    let x_forwarded_for =
        sanitize_log_value(header(&parts.headers, "x-forwarded-for").unwrap_or("-"));

    match handle {
        Some(handle) => {
            let ss = handle.session_state().lock().await;
            match ss.user_info.clone() {
                Some(ref user_info) => {
                    info_span!("HTTP", session=%handle.id(), session_username=%user_info.username, %client_ip, %user_agent, %x_forwarded_for)
                }
                None => {
                    info_span!("HTTP", session=%handle.id(), %client_ip, %user_agent, %x_forwarded_for)
                }
            }
        }
        None => info_span!("HTTP", %client_ip, %user_agent, %x_forwarded_for),
    }
}

fn is_static_resource(url: &Uri) -> bool {
    let path = url.path();
    path == "/ui" || path.starts_with("/ui/")
}

pub fn log_request_result(
    method: &Method,
    url: &Uri,
    client_ip: Option<&str>,
    status: &StatusCode,
) {
    if is_static_resource(url) {
        return;
    }
    let client_ip = client_ip.unwrap_or("<unknown>");
    let url = sanitize_log_value(&url.to_string());
    if status.is_server_error() || status.is_client_error() {
        warn!(%method, %url, %status, %client_ip, "Request failed");
    } else {
        info!(%method, %url, %status, %client_ip, "Request");
    }
}

pub fn log_request_error<E: Debug>(method: &Method, url: &Uri, client_ip: Option<&str>, error: &E) {
    let client_ip = client_ip.unwrap_or("<unknown>");
    let url = sanitize_log_value(&url.to_string());
    error!(%method, %url, ?error, %client_ip, "Request failed");
}

#[cfg(test)]
mod tests {
    use super::sanitize_log_value;

    #[test]
    fn sanitize_strips_crlf_and_ansi() {
        // Simulated attacker-controlled header value: CR/LF to inject a forged
        // line plus an ANSI escape sequence intended to run in a terminal.
        let raw = "Mozilla/5.0\r\nINFO forged log line\x1b[31mred";
        let cleaned = sanitize_log_value(raw);

        // No raw control characters survive.
        assert!(!cleaned.contains('\n'));
        assert!(!cleaned.contains('\r'));
        assert!(!cleaned.contains('\x1b'));
        assert!(!cleaned.chars().any(|c| c.is_control()));

        // They are backslash-escaped instead.
        assert_eq!(cleaned, "Mozilla/5.0\\r\\nINFO forged log line\\x1b[31mred");
    }

    #[test]
    fn sanitize_leaves_normal_text_untouched() {
        let raw = "GET /api/v1/sessions?id=42";
        assert_eq!(sanitize_log_value(raw), raw);
    }
}
