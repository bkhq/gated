use std::fmt::Debug;
use std::net::ToSocketAddrs;

use poem::http::{Method, StatusCode, Uri};
use poem::web::{Data, RemoteAddr};
use poem::{Addr, FromRequest, Request};
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

pub async fn get_client_ip(req: &Request, services: Option<&Services>) -> Option<String> {
    let trust_x_forwarded_headers = if let Some(services) = services {
        let config = services.config.read().await;
        config.store.http.trust_x_forwarded_headers
    } else {
        false
    };

    let socket_addr = match req.remote_addr() {
        // See [CertificateExtractorEndpoint]
        RemoteAddr(Addr::Custom("captured-cert", value)) => {
            #[allow(
                clippy::unwrap_used,
                reason = "str::split always yields at least one element"
            )]
            let original_remote_addr = value.split("|").next().unwrap();
            original_remote_addr
                .to_socket_addrs()
                .ok()
                .and_then(|i| i.into_iter().next())
        }
        other => other.as_socket_addr().cloned(),
    };

    let remote_ip = socket_addr.map(|x| x.ip().to_string());

    if trust_x_forwarded_headers {
        req.header("x-forwarded-for")
            .map(|x| x.to_string())
            .or(remote_ip)
    } else {
        remote_ip
    }
}

pub async fn span_for_request(
    req: &Request,
    handle: Option<&GatedServerHandle>,
) -> poem::Result<Span> {
    let services = Data::<&Services>::from_request_without_body(req).await.ok();
    let client_ip = get_client_ip(req, services.as_deref().copied())
        .await
        .unwrap_or("<unknown>".into());
    let user_agent = sanitize_log_value(req.header("user-agent").unwrap_or("-"));
    let x_forwarded_for = sanitize_log_value(req.header("x-forwarded-for").unwrap_or("-"));

    Ok(match handle {
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
    })
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
