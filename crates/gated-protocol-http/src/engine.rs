use std::collections::HashMap;
use std::future::Future;

use anyhow::Context;
use bytes::{Bytes, BytesMut};
use futures::{Stream, StreamExt, TryStreamExt};
use gated_common::http_headers::{
    API_PROXY_MAX_BODY_SIZE, DONT_FORWARD_HEADERS, X_GATED_TARGET, X_GATED_TOKEN,
};
use gated_common::{GatedError, HttpProxyFlavor, TargetHttpOptions, UpstreamAuth};
use gated_tls::TlsMode;
use poem::{Body, Request, Response};
use tracing::*;
use url::Url;
use x509_parser::pem::Pem;

/// Controls flavor-specific behaviour inside the shared engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlavorHook {
    Generic,
    Kubernetes,
}

impl From<HttpProxyFlavor> for FlavorHook {
    fn from(value: HttpProxyFlavor) -> Self {
        match value {
            HttpProxyFlavor::Generic => FlavorHook::Generic,
            HttpProxyFlavor::Kubernetes => FlavorHook::Kubernetes,
        }
    }
}

const STRIP_UPSTREAM_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "authorization",
];

// Headers that must never be copied verbatim from the upstream
// response to the client. The content-* set keeps the body framing honest;
// the hop-by-hop set (Connection/Upgrade/Keep-Alive/Proxy-*/TE/Trailer) is
// per-connection metadata that must not be tunnelled through the proxy; and
// `Strict-Transport-Security` must originate from the bastion, not an
// arbitrary upstream target.
const STRIP_RESPONSE_HEADERS: &[&str] = &[
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "strict-transport-security",
];

/// Strip the `Domain=` attribute from an upstream `Set-Cookie` so
/// the cookie can never be widened to the shared wildcard parent domain (which
/// would let one target inject a cookie into sibling targets). Removing
/// `Domain` makes the cookie host-only, scoped to the exact host the browser
/// is talking to.
fn sanitize_set_cookie(value: &str) -> String {
    value
        .split(';')
        .map(str::trim)
        .filter(|seg| !seg.to_ascii_lowercase().starts_with("domain="))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Neutralize open redirects. The (possibly relative,
/// protocol-relative, or absolute) `Location` value is resolved against the
/// upstream request URL exactly as a browser hop would, then required to stay
/// on the same upstream host:port. Same-host redirects are rewritten to a
/// relative reference so the browser stays within the target's proxied origin;
/// anything that escapes to another host is dropped (`None`).
fn sanitize_location(value: &str, upstream_url: &Url) -> Option<String> {
    let resolved = upstream_url.join(value).ok()?;
    if resolved.host_str() == upstream_url.host_str()
        && resolved.port_or_known_default() == upstream_url.port_or_known_default()
    {
        let mut rel = String::from(resolved.path());
        if let Some(q) = resolved.query() {
            rel.push('?');
            rel.push_str(q);
        }
        if let Some(f) = resolved.fragment() {
            rel.push('#');
            rel.push_str(f);
        }
        Some(rel)
    } else {
        None
    }
}

pub trait HttpProxyRecorder {
    fn record_response(
        &mut self,
        method: &str,
        path: &str,
        headers: HashMap<String, String>,
        request_body: &[u8],
        status: u16,
        response_body: &[u8],
    ) -> impl Future<Output = Result<(), gated_core::recordings::Error>> + Send;
}

/// Names of headers that the upstream-auth configuration injects via
/// `default_headers`.  Used by the engine to drop any incoming client header
/// that would shadow an injected value.  Only meaningful for the `Headers`
/// variant; `BearerToken` injects only `Authorization`, which the engine
/// always strips anyway; `ClientCertificate` and `None` inject nothing.
pub fn injected_header_names(upstream_auth: &UpstreamAuth) -> Vec<String> {
    match upstream_auth {
        UpstreamAuth::Headers(headers) => {
            headers.headers.keys().map(|n| n.to_lowercase()).collect()
        }
        UpstreamAuth::BearerToken(_)
        | UpstreamAuth::ClientCertificate(_)
        | UpstreamAuth::None(_) => Vec::new(),
    }
}

/// Build an HTTP client with TLS, CA bundle, and upstream credentials wired
/// up from `TargetHttpOptions`.  Validates the URL scheme against `tls.mode`
/// to prevent SSRF.
pub fn build_http_client(options: &TargetHttpOptions) -> anyhow::Result<reqwest::Client> {
    let parsed_url = Url::parse(&options.url).context("parsing upstream URL")?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => anyhow::bail!(
            "unsupported upstream URL scheme '{}': only http and https are allowed",
            scheme
        ),
    }

    match options.tls.mode {
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

    let mut client_builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());

    if !options.tls.verify {
        client_builder = client_builder.danger_accept_invalid_certs(true);
    }

    if let Some(ca_pem) = &options.ca_certificate {
        let ca_pem = ca_pem.expose_secret();
        if !ca_pem.trim().is_empty() {
            let mut cert_count = 0usize;
            for pem in Pem::iter_from_buffer(ca_pem.as_bytes()) {
                let pem = pem.context("parsing upstream CA PEM bundle")?;
                if pem.label != "CERTIFICATE" {
                    continue;
                }
                let certificate = reqwest::Certificate::from_der(&pem.contents)
                    .context("parsing upstream CA certificate")?;
                client_builder = client_builder.add_root_certificate(certificate);
                cert_count += 1;
            }
            if cert_count == 0 {
                anyhow::bail!("upstream CA bundle contains no certificates");
            }
        }
    }

    match &options.upstream_auth {
        UpstreamAuth::None(_) => {}
        UpstreamAuth::Headers(auth) => {
            let mut default_headers = reqwest::header::HeaderMap::new();
            for (name, value) in &auth.headers {
                default_headers.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes())
                        .context("invalid injected header name")?,
                    reqwest::header::HeaderValue::from_str(value.expose_secret())
                        .context("invalid injected header value")?,
                );
            }
            client_builder = client_builder.default_headers(default_headers);
        }
        UpstreamAuth::BearerToken(auth) => {
            let mut default_headers = reqwest::header::HeaderMap::new();
            default_headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!(
                    "Bearer {}",
                    auth.token.expose_secret()
                ))
                .context("setting Authorization header")?,
            );
            client_builder = client_builder.default_headers(default_headers);
        }
        UpstreamAuth::ClientCertificate(auth) => {
            let cert_pem = auth.certificate.expose_secret();
            let key_pem = auth.private_key.expose_secret();
            let mut pem_bundle = String::new();
            pem_bundle.push_str(cert_pem);
            if !pem_bundle.ends_with('\n') {
                pem_bundle.push('\n');
            }
            pem_bundle.push_str(key_pem);
            if !pem_bundle.ends_with('\n') {
                pem_bundle.push('\n');
            }
            let identity = reqwest::Identity::from_pem(pem_bundle.as_bytes())
                .context("invalid upstream client certificate/private key")?;
            client_builder = client_builder.identity(identity);
        }
    }

    // Surface the full error chain via {:#}; the default {} prints only the
    // outermost layer and hides TLS diagnostics such as rustls-webpki errors.
    client_builder
        .build()
        .map_err(|e| anyhow::anyhow!("building reqwest client: {e:#}"))
}

pub fn construct_target_url(
    req: &Request,
    path: &str,
    base_url: &str,
    flavor: FlavorHook,
) -> anyhow::Result<Url> {
    if flavor == FlavorHook::Generic {
        for segment in path.split('/') {
            let decoded = urlencoding::decode(segment).unwrap_or_default();
            if segment == ".." || decoded == ".." {
                anyhow::bail!("path traversal detected: '..' segments are not allowed");
            }
        }
    }

    let normalized_path = path.trim_start_matches('/');
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

    if flavor == FlavorHook::Generic {
        for seg in parsed.path_segments().into_iter().flatten() {
            if seg == ".." {
                anyhow::bail!("path traversal detected after URL normalisation");
            }
        }
    }

    Ok(parsed)
}

pub fn collect_forwarded_headers(
    req: &Request,
    injected_header_names: &[String],
    flavor: FlavorHook,
) -> HashMap<String, String> {
    let mut headers = HashMap::new();

    for (name, value) in req.headers() {
        if DONT_FORWARD_HEADERS.contains(name)
            && !(flavor == FlavorHook::Kubernetes && name == http::header::ACCEPT_ENCODING)
        {
            continue;
        }
        if name == X_GATED_TARGET || name == X_GATED_TOKEN {
            continue;
        }
        if name == http::header::AUTHORIZATION {
            continue;
        }
        // Never forward Kubernetes impersonation headers
        // (`Impersonate-User`, `Impersonate-Group`, `Impersonate-Uid`,
        // `Impersonate-Extra-*`). Otherwise a downstream client could
        // impersonate an arbitrary K8s identity to the upstream API server.
        // `HeaderName::as_str` is always lowercase, so this prefix match is
        // case-insensitive and covers the `Impersonate-Extra-*` family too.
        if name.as_str().starts_with("impersonate-") {
            continue;
        }
        if injected_header_names
            .iter()
            .any(|injected| injected == &name.as_str().to_lowercase())
        {
            continue;
        }

        match value.to_str() {
            Ok(value_str) => {
                let final_value =
                    if flavor == FlavorHook::Kubernetes && name == http::header::ACCEPT {
                        value_str
                            .split(',')
                            .map(|s| s.trim())
                            .filter(|s| *s != "application/vnd.kubernetes.protobuf")
                            .collect::<Vec<_>>()
                            .join(", ")
                    } else {
                        value_str.to_string()
                    };
                headers.insert(name.to_string(), final_value);
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

async fn read_body_with_limit(body: Body) -> Result<Bytes, GatedError> {
    body.into_bytes_limit(API_PROXY_MAX_BODY_SIZE)
        .await
        .map_err(|e| GatedError::Other(anyhow::anyhow!("reading request body: {}", e).into()))
}

/// Read an upstream response body into memory while enforcing `limit`
/// during the read. The accumulated size is checked before each chunk is
/// appended, so the buffer never holds an oversized body; the read aborts
/// with an error the moment the cap would be exceeded.
async fn collect_capped_body<S, E>(stream: S, limit: usize) -> Result<Bytes, GatedError>
where
    S: Stream<Item = Result<Bytes, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    futures::pin_mut!(stream);
    let mut buf = BytesMut::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("reading upstream response")?;
        if buf.len().saturating_add(chunk.len()) > limit {
            return Err(GatedError::Other(
                anyhow::anyhow!(
                    "upstream response too large: exceeds limit of {} bytes",
                    limit
                )
                .into(),
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf.freeze())
}

/// Wrap a streaming response body so it yields chunks unchanged until the
/// cumulative size exceeds `limit`, at which point it emits a single error
/// and the consumer stops pulling. This bounds memory for chunked / watch
/// responses without ever buffering the full body.
fn cap_body_stream<S>(stream: S, limit: usize) -> impl Stream<Item = std::io::Result<Bytes>>
where
    S: Stream<Item = std::io::Result<Bytes>>,
{
    let mut total: usize = 0;
    stream.map(move |chunk| {
        let chunk = chunk?;
        total = total.saturating_add(chunk.len());
        if total > limit {
            return Err(std::io::Error::other(format!(
                "upstream response too large: exceeds limit of {limit} bytes"
            )));
        }
        Ok(chunk)
    })
}

async fn send_upstream_request(
    client: &reqwest::Client,
    method: &str,
    full_url: &Url,
    headers: &HashMap<String, String>,
    body_bytes: &Bytes,
) -> Result<reqwest::Response, GatedError> {
    let mut request_builder = client.request(
        http::Method::from_bytes(method.as_bytes()).context("request method")?,
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

    Ok(request_builder.send().await?)
}

#[allow(clippy::too_many_arguments, reason = "engine plumbing")]
async fn build_downstream_response<R: HttpProxyRecorder>(
    response: reqwest::Response,
    req: &Request,
    full_url: &Url,
    method: &str,
    headers: HashMap<String, String>,
    body_bytes: &Bytes,
    flavor: FlavorHook,
    recorder_opt: &mut Option<R>,
) -> Result<Response, GatedError> {
    let status = response.status();
    let response_headers = response.headers().clone();

    debug!(
        method = method,
        url = %full_url,
        status = %status,
        "Received response from upstream"
    );

    let (response_body, body_for_recording) = {
        let transfer_encoding = response_headers
            .get(poem::http::header::TRANSFER_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_lowercase();

        let is_watch = flavor == FlavorHook::Kubernetes
            && req
                .uri()
                .query()
                .map(|q| q.split('&').any(|p| p.starts_with("watch=true")))
                .unwrap_or(false);

        if transfer_encoding == "chunked" || is_watch {
            // Streaming branch: never materialize the whole body. Wrap the
            // upstream stream so it errors out as soon as the cumulative
            // size exceeds the cap, bounding memory for chunked / watch
            // responses too.
            let capped = cap_body_stream(
                response.bytes_stream().map_err(std::io::Error::other),
                API_PROXY_MAX_BODY_SIZE,
            );
            (Body::from_bytes_stream(capped), None)
        } else {
            // Buffering branch: accumulate the body incrementally and abort
            // BEFORE the cap is exceeded, so an oversized upstream body is
            // never fully read into memory.
            let bytes =
                collect_capped_body(response.bytes_stream(), API_PROXY_MAX_BODY_SIZE).await?;
            let recording_bytes = bytes.to_vec();
            (Body::from_bytes(bytes), Some(recording_bytes))
        }
    };

    if let Some(ref mut recorder) = recorder_opt {
        if let Err(e) = recorder
            .record_response(
                method,
                full_url.as_ref(),
                headers,
                body_bytes,
                status.as_u16(),
                body_for_recording.unwrap_or_default().as_ref(),
            )
            .await
        {
            warn!("Failed to record response: {}", e);
        }
    }

    let mut poem_response = Response::builder().status(status);

    for (name, value) in response_headers.iter() {
        let name_str = name.as_str();
        if STRIP_RESPONSE_HEADERS.contains(&name_str) {
            continue;
        }
        // Rewrite Set-Cookie to drop a parent-domain widening.
        if name_str == "set-cookie" {
            let Ok(raw) = value.to_str() else { continue };
            let sanitized = sanitize_set_cookie(raw);
            if let Ok(poem_value) = poem::http::HeaderValue::from_str(&sanitized) {
                poem_response = poem_response.header(poem::http::header::SET_COOKIE, poem_value);
            }
            continue;
        }
        // Neutralize off-target redirects; drop the header when the
        // Location escapes the upstream host.
        if name_str == "location" {
            match value
                .to_str()
                .ok()
                .and_then(|v| sanitize_location(v, full_url))
            {
                Some(loc) => {
                    if let Ok(poem_value) = poem::http::HeaderValue::from_str(&loc) {
                        poem_response =
                            poem_response.header(poem::http::header::LOCATION, poem_value);
                    }
                }
                None => continue,
            }
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

/// Shared proxy core: collect headers, forward to upstream, optionally
/// record, build the downstream response.  Caller supplies a pre-built
/// `reqwest::Client` from [`build_http_client`].
#[allow(
    clippy::too_many_arguments,
    reason = "engine plumbing; grouping into a struct just shifts the noise"
)]
pub async fn proxy_to_upstream<R: HttpProxyRecorder>(
    req: &Request,
    body: Body,
    base_url: &str,
    client: &reqwest::Client,
    flavor: FlavorHook,
    injected_header_names: &[String],
    path: &str,
    mut recorder_opt: Option<R>,
) -> Result<Response, GatedError> {
    let method = req.method().as_str().to_owned();
    let full_url =
        construct_target_url(req, path, base_url, flavor).context("constructing target URL")?;

    let headers = collect_forwarded_headers(req, injected_header_names, flavor);
    let body_bytes = read_body_with_limit(body).await?;

    debug!(
        method = method,
        url = %full_url,
        flavor = ?flavor,
        "Proxying request to upstream"
    );

    let response = send_upstream_request(client, &method, &full_url, &headers, &body_bytes).await?;

    build_downstream_response(
        response,
        req,
        &full_url,
        &method,
        headers,
        &body_bytes,
        flavor,
        &mut recorder_opt,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use bytes::Bytes;
    use futures::{stream, StreamExt};
    use poem::Request;

    use url::Url;

    use super::{
        cap_body_stream, collect_capped_body, collect_forwarded_headers, sanitize_location,
        sanitize_set_cookie, FlavorHook,
    };

    /// Client-supplied forwarding/identity headers must
    /// not be forwarded upstream — `Cookie` would leak the bastion session
    /// cookie, and the `X-Forwarded-*` / `Forwarded` / `Host` family is
    /// attacker-controlled. Unrelated headers must still pass.
    #[test]
    fn collect_forwarded_headers_strips_forwarding_and_cookie() {
        let req = Request::builder()
            .header("Cookie", "session=secret")
            .header("X-Forwarded-For", "1.2.3.4")
            .header("X-Forwarded-Host", "evil.example")
            .header("X-Forwarded-Proto", "https")
            .header("Forwarded", "for=1.2.3.4")
            .header("Host", "evil.example")
            .header("X-Custom", "keep-me")
            .finish();

        let headers = collect_forwarded_headers(&req, &[], FlavorHook::Generic);

        for blocked in [
            "cookie",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "forwarded",
            "host",
        ] {
            assert!(
                !headers.keys().any(|k| k.to_ascii_lowercase() == blocked),
                "{blocked} must not be forwarded, got keys: {:?}",
                headers.keys().collect::<Vec<_>>()
            );
        }
        assert_eq!(headers.get("x-custom").map(String::as_str), Some("keep-me"));
    }

    /// A `Domain=` widening to the shared parent domain
    /// must be stripped so the cookie cannot be injected into sibling targets.
    #[test]
    fn sanitize_set_cookie_strips_domain() {
        let out = sanitize_set_cookie("sid=abc; Domain=.parent.example; Path=/; HttpOnly");
        assert!(
            !out.to_ascii_lowercase().contains("domain="),
            "Domain attribute must be removed, got: {out}"
        );
        assert!(
            out.contains("sid=abc"),
            "cookie value must be preserved: {out}"
        );
        assert!(
            out.contains("HttpOnly"),
            "other attributes must be preserved: {out}"
        );
    }

    /// A redirect to an off-target host must be dropped,
    /// a relative redirect kept, and a same-host absolute redirect rewritten to
    /// a relative reference that stays within the proxied origin.
    #[test]
    fn sanitize_location_neutralizes_off_target() {
        let upstream = Url::parse("https://app.internal/foo/bar").unwrap();

        assert_eq!(
            sanitize_location("https://evil.example/phish", &upstream),
            None
        );
        // Protocol-relative escapes to another host and must be dropped too.
        assert_eq!(sanitize_location("//evil.example/phish", &upstream), None);
        // Relative redirect stays on the proxied origin.
        assert_eq!(
            sanitize_location("/dashboard?x=1", &upstream).as_deref(),
            Some("/dashboard?x=1")
        );
        // Same-host absolute redirect is rewritten to a relative reference.
        assert_eq!(
            sanitize_location("https://app.internal/next?y=2", &upstream).as_deref(),
            Some("/next?y=2")
        );
    }

    /// `collect_forwarded_headers` must drop every
    /// Kubernetes impersonation header so a client cannot impersonate an
    /// arbitrary identity to the upstream API server, while still forwarding
    /// unrelated headers.
    #[test]
    fn collect_forwarded_headers_strips_impersonation_headers() {
        let req = Request::builder()
            .header("Impersonate-User", "system:admin")
            .header("Impersonate-Group", "system:masters")
            .header("Impersonate-Uid", "1234-uid")
            .header("Impersonate-Extra-scopes", "development")
            .header("X-Custom", "keep-me")
            .finish();

        let headers = collect_forwarded_headers(&req, &[], FlavorHook::Kubernetes);

        assert!(
            !headers
                .keys()
                .any(|k| k.to_ascii_lowercase().starts_with("impersonate-")),
            "impersonation headers must be stripped, got keys: {:?}",
            headers.keys().collect::<Vec<_>>()
        );
        assert_eq!(headers.get("x-custom").map(String::as_str), Some("keep-me"));
    }

    fn chunk(n: usize) -> Bytes {
        Bytes::from(vec![b'x'; n])
    }

    // Buffering branch: a sub-cap body is read through unchanged.
    #[tokio::test]
    async fn collect_capped_body_passes_sub_cap() {
        let chunks: Vec<Result<Bytes, std::io::Error>> =
            vec![Ok(chunk(4)), Ok(chunk(4)), Ok(chunk(2))];
        let out = collect_capped_body(stream::iter(chunks), 16).await.unwrap();
        assert_eq!(out.len(), 10);
    }

    // Buffering branch: an over-cap body aborts WITHOUT fully buffering.
    // The source stream tracks how many chunks were actually polled; once
    // the cap is exceeded the read must stop, so later chunks are never
    // pulled (and thus never materialized in memory).
    #[tokio::test]
    async fn collect_capped_body_aborts_over_cap_without_buffering() {
        let polled = Rc::new(Cell::new(0usize));
        let p = polled.clone();
        // 4 chunks of 10 bytes each (40 total) against a 15-byte cap. The
        // cap is crossed at the 2nd chunk, so chunks 3 and 4 must not be
        // polled — proving the whole 40-byte body is never buffered.
        let src = stream::iter(0..4).map(move |_| {
            p.set(p.get() + 1);
            Ok::<Bytes, std::io::Error>(chunk(10))
        });
        let err = collect_capped_body(src, 15).await.unwrap_err();
        assert!(err.to_string().contains("too large"), "got: {err}");
        assert_eq!(polled.get(), 2, "must stop reading once the cap is crossed");
    }

    // Streaming branch: sub-cap chunks pass through untouched.
    #[tokio::test]
    async fn cap_body_stream_passes_sub_cap() {
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![Ok(chunk(5)), Ok(chunk(5))];
        let collected: Vec<_> = cap_body_stream(stream::iter(chunks), 16).collect().await;
        assert_eq!(collected.len(), 2);
        assert!(collected.iter().all(|r| r.is_ok()));
    }

    // Streaming branch: the cap fires mid-stream, before the full body is
    // consumed, and the consumer stops pulling further chunks.
    #[tokio::test]
    async fn cap_body_stream_errors_over_cap_mid_stream() {
        let polled = Rc::new(Cell::new(0usize));
        let p = polled.clone();
        let src = stream::iter(0..4).map(move |_| {
            p.set(p.get() + 1);
            Ok::<Bytes, std::io::Error>(chunk(10))
        });
        // Consume until the first error, mirroring how Body::from_bytes_stream
        // tears down on an Err item.
        let mut capped = Box::pin(cap_body_stream(src, 15));
        let mut ok = 0usize;
        let mut errored = false;
        while let Some(item) = capped.next().await {
            match item {
                Ok(_) => ok += 1,
                Err(_) => {
                    errored = true;
                    break;
                }
            }
        }
        assert!(errored, "stream must surface an oversize error");
        assert_eq!(ok, 1, "only the first sub-cap chunk should pass");
        assert_eq!(polled.get(), 2, "must stop pulling once the cap is crossed");
    }
}
