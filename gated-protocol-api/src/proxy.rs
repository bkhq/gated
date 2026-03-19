use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context;
use futures::TryStreamExt;
use poem::{Body, Request, Response};
use tokio::sync::Mutex;
use tracing::*;
use url::Url;
use gated_common::http_headers::{
    API_PROXY_MAX_BODY_SIZE, DONT_FORWARD_HEADERS, X_GATED_TARGET, X_GATED_TOKEN,
};
use gated_common::{SessionId, TargetApiOptions, GatedError};
use gated_core::recordings::SessionRecordings;
use gated_core::Services;

use crate::recording::start_recording_api;

/// Headers stripped when sending to upstream.
///
/// This list provides a second-pass guard at send time, complementing
/// `DONT_FORWARD_HEADERS` which filters at collection time.  The overlap
/// (host, connection, transfer-encoding) is intentional defence-in-depth:
/// `DONT_FORWARD_HEADERS` is the primary filter, this list catches anything
/// that slips through the HashMap intermediary.
const STRIP_UPSTREAM_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "authorization",
];

/// Response headers that must not be forwarded back to the client.
///
/// `content-encoding` and `content-length` are stripped because reqwest
/// transparently decompresses gzip/br responses (the `gzip` cargo feature is
/// enabled), so the raw bytes we forward are already decompressed — sending the
/// original `Content-Encoding: gzip` header would cause the client to attempt a
/// second decompression, corrupting the response.  `content-length` is stripped
/// because the decompressed body length differs from the original.
/// `transfer-encoding` is a hop-by-hop header that must not be forwarded.
const STRIP_RESPONSE_HEADERS: &[&str] = &[
    "content-encoding",
    "content-length",
    "transfer-encoding",
];

/// Construct the full upstream URL from the base URL and request path.
///
/// Rejects paths containing `..` segments (including percent-encoded variants
/// like `%2e%2e`) to prevent path traversal.
pub fn construct_target_url(req: &Request, path: &str, base_url: &str) -> anyhow::Result<Url> {
    // Reject path traversal attempts.
    // Check both raw segments and percent-decoded segments to catch %2e%2e etc.
    for segment in path.split('/') {
        let decoded = urlencoding::decode(segment).unwrap_or_default();
        if segment == ".." || decoded == ".." {
            anyhow::bail!("path traversal detected: '..' segments are not allowed");
        }
    }

    let normalized_path = path.trim_start_matches('/');
    // Query string is forwarded as-is. This is standard proxy behaviour;
    // query parameters are opaque to the proxy and passed through unchanged.
    let query = req.uri().query().unwrap_or("");

    let url_str = if query.is_empty() {
        format!("{}/{}", base_url.trim_end_matches('/'), normalized_path)
    } else {
        format!(
            "{}/{}?{}",
            base_url.trim_end_matches('/'),
            normalized_path,
            query
        )
    };

    let parsed = Url::parse(&url_str)?;

    // Post-parse safety: verify the normalised path does not escape the base.
    // Url::parse resolves `.` and `..` segments, so check for remaining `..`.
    for seg in parsed.path_segments().into_iter().flatten() {
        if seg == ".." {
            anyhow::bail!("path traversal detected after URL normalisation");
        }
    }

    Ok(parsed)
}

/// Collect headers from the incoming request that should be forwarded to upstream.
///
/// Strips hop-by-hop headers, authorization, Gated-internal headers, and
/// `Accept-Encoding` (reqwest handles content negotiation with its own
/// Accept-Encoding based on enabled features like gzip).
/// Also strips any header names that are used by injected upstream credentials
/// to prevent client-supplied headers from shadowing injected credentials.
pub fn collect_forwarded_headers(
    req: &Request,
    api_options: &TargetApiOptions,
) -> HashMap<String, String> {
    let injected_header_names = get_injected_header_names(api_options);
    let mut headers = HashMap::new();

    for (name, value) in req.headers() {
        if DONT_FORWARD_HEADERS.contains(name) {
            continue;
        }
        if name == &X_GATED_TARGET || name == &X_GATED_TOKEN {
            continue;
        }
        if name == http::header::AUTHORIZATION {
            continue;
        }
        // Prevent client headers from shadowing injected credentials
        if injected_header_names.contains(&name.as_str().to_lowercase()) {
            continue;
        }
        match value.to_str() {
            Ok(value_str) => {
                headers.insert(name.to_string(), value_str.to_string());
            }
            Err(_) => {
                warn!(
                    header = %name,
                    "Dropping non-UTF-8 header value from forwarded request"
                );
            }
        }
    }

    headers
}

/// Get the set of header names that will be injected by upstream configuration.
fn get_injected_header_names(api_options: &TargetApiOptions) -> Vec<String> {
    api_options
        .headers
        .keys()
        .map(|n| n.to_lowercase())
        .collect()
}

/// Build a reqwest client with upstream credentials injected as default headers.
/// Validates the upstream URL scheme against `tls.mode` and disables redirect following.
pub fn create_authenticated_client(
    api_options: &TargetApiOptions,
) -> anyhow::Result<reqwest::ClientBuilder> {
    use gated_tls::TlsMode;

    // Validate upstream URL scheme to prevent SSRF
    let parsed_url = Url::parse(&api_options.url).context("parsing upstream URL")?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => anyhow::bail!(
            "unsupported upstream URL scheme '{}': only http and https are allowed",
            scheme
        ),
    }

    // Enforce tls.mode against the actual URL scheme
    match api_options.tls.mode {
        TlsMode::Required if parsed_url.scheme() == "http" => {
            anyhow::bail!(
                "upstream URL uses http:// but tls.mode is 'required'; \
                 use an https:// URL or set tls.mode to 'preferred' or 'disabled'"
            );
        }
        TlsMode::Disabled if parsed_url.scheme() == "https" => {
            anyhow::bail!(
                "upstream URL uses https:// but tls.mode is 'disabled'; \
                 use an http:// URL or set tls.mode to 'preferred' or 'required'"
            );
        }
        _ => {}
    }

    let mut client_builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none());

    if !api_options.tls.verify {
        client_builder = client_builder.danger_accept_invalid_certs(true);
    }

    let mut default_headers = reqwest::header::HeaderMap::new();

    for (name, value) in &api_options.headers {
        default_headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .context("invalid header name")?,
            reqwest::header::HeaderValue::from_str(value.expose_secret())
                .context("setting header value")?,
        );
    }

    client_builder = client_builder.default_headers(default_headers);

    Ok(client_builder)
}

/// Read the request body with a streaming size limit.
///
/// Uses `Body::into_bytes_limit` so that oversized payloads are rejected
/// during streaming without buffering the entire body first.
async fn read_body_with_limit(body: Body) -> Result<bytes::Bytes, GatedError> {
    body.into_bytes_limit(API_PROXY_MAX_BODY_SIZE)
        .await
        .map_err(|e| GatedError::Other(anyhow::anyhow!("reading request body: {}", e).into()))
}

/// Build and send the upstream HTTP request.
/// Returns the reqwest response.
async fn send_upstream_request(
    client: &reqwest::Client,
    method: &str,
    full_url: &Url,
    headers: &HashMap<String, String>,
    body_bytes: &bytes::Bytes,
    username: &str,
) -> Result<reqwest::Response, GatedError> {
    let mut request_builder = client.request(
        http::Method::from_bytes(method.as_bytes())
            .context("request method")?,
        full_url.clone(),
    );

    for (name, value) in headers {
        let header_name_lower = name.to_lowercase();
        if !STRIP_UPSTREAM_HEADERS.contains(&header_name_lower.as_str()) {
            if let (Ok(header_name), Ok(header_value)) = (
                http::HeaderName::from_bytes(name.as_bytes()),
                http::HeaderValue::from_str(value),
            ) {
                request_builder = request_builder.header(header_name, header_value);
            }
        }
    }

    if !body_bytes.is_empty() {
        request_builder = request_builder.body(body_bytes.to_vec());
    }

    debug!(
        method = method,
        url = %full_url,
        user = %username,
        "Proxying API request to upstream"
    );

    Ok(request_builder.send().await?)
}

/// Read the upstream response body and build the poem Response.
///
/// Applies a size limit symmetric with the request body limit.
/// Strips hop-by-hop and content-encoding headers that are invalid after
/// reqwest's transparent decompression.
async fn build_downstream_response(
    response: reqwest::Response,
    full_url: &Url,
    method: &str,
    headers: &HashMap<String, String>,
    body_bytes: &bytes::Bytes,
    recorder_opt: &mut Option<crate::recording::ApiRecorder>,
) -> Result<Response, GatedError> {
    let status = response.status();
    let response_headers = response.headers().clone();

    debug!(
        method = method,
        url = %full_url,
        status = %status,
        "Received response from upstream API"
    );

    // Read response body with size limit
    let (response_body, body_for_recording) = {
        let transfer_encoding = response_headers
            .get(poem::http::header::TRANSFER_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_lowercase();

        if transfer_encoding == "chunked" {
            (
                Body::from_bytes_stream(
                    response
                        .bytes_stream()
                        .map_err(std::io::Error::other),
                ),
                None,
            )
        } else {
            let bytes = response
                .bytes()
                .await
                .context("reading upstream response")?;
            if bytes.len() > API_PROXY_MAX_BODY_SIZE {
                return Err(GatedError::Other(
                    anyhow::anyhow!(
                        "upstream response too large: {} bytes exceeds limit of {} bytes",
                        bytes.len(),
                        API_PROXY_MAX_BODY_SIZE
                    )
                    .into(),
                ));
            }
            let recording_bytes = bytes.to_vec();
            (Body::from_bytes(bytes), Some(recording_bytes))
        }
    };

    // Record the request/response (recordings are admin-only audit data)
    if let Some(ref mut recorder) = recorder_opt {
        if let Err(e) = recorder
            .record_response(
                method,
                &full_url.to_string(),
                headers.clone(),
                body_bytes,
                status.as_u16(),
                body_for_recording.unwrap_or_default().as_ref(),
            )
            .await
        {
            warn!("Failed to record API response: {}", e);
        }
    }

    // Build response, stripping headers that are invalid after decompression
    let mut poem_response = Response::builder().status(status);

    for (name, value) in response_headers.iter() {
        let name_str = name.as_str();
        if STRIP_RESPONSE_HEADERS.contains(&name_str) {
            continue;
        }
        if let Ok(poem_name) = poem::http::HeaderName::from_bytes(name_str.as_bytes()) {
            if let Ok(poem_value) = poem::http::HeaderValue::from_bytes(value.as_bytes()) {
                poem_response = poem_response.header(poem_name, poem_value);
            }
        }
    }

    Ok(poem_response.body(response_body))
}

/// Shared proxy logic: build authenticated client, forward request to upstream,
/// handle recording, and return the response.
pub async fn proxy_to_upstream(
    req: &Request,
    body: Body,
    api_options: &TargetApiOptions,
    path: &str,
    username: &str,
    session_id: SessionId,
    services: &Services,
    recordings: &Arc<Mutex<SessionRecordings>>,
) -> Result<Response, GatedError> {
    let client = create_authenticated_client(api_options)?
        .build()
        .context("building reqwest client")?;

    let method = req.method().as_str();
    let full_url =
        construct_target_url(req, path, &api_options.url).context("constructing target URL")?;

    let headers = collect_forwarded_headers(req, api_options);
    let body_bytes = read_body_with_limit(body).await?;

    // Start recording if enabled
    let mut recorder_opt = {
        let enabled = {
            let config = services.config.lock().await;
            config.store.recordings.enable
        };
        if enabled {
            match start_recording_api(&session_id, recordings).await {
                Ok(recorder) => Some(recorder),
                Err(e) => {
                    warn!("Failed to start recording: {}", e);
                    None
                }
            }
        } else {
            None
        }
    };

    let response = send_upstream_request(
        &client, method, &full_url, &headers, &body_bytes, username,
    )
    .await?;

    build_downstream_response(
        response, &full_url, method, &headers, &body_bytes, &mut recorder_opt,
    )
    .await
}
