//! Unified HTTP-proxy listener.
//!
//! Single listener, single port: handles both Generic-flavor and
//! Kubernetes-flavor HTTP reverse-proxy targets.  Target identification is
//! by [`crate::resolver`] (X-Gated-Target header → Host fallback → 401).
//! Downstream authentication is Bearer token OR mTLS client certificate.

use std::sync::Arc;

use anyhow::Context;
use axum::body::Body;
use axum::extract::{Request, WebSocketUpgrade};
use axum::http::request::Parts;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Router};
use gated_common::auth::AuthStateUserInfo;
use gated_common::http_headers::scrub_secret_query_params;
use gated_common::web::server::{ConnectionInfo, serve};
use gated_common::{GatedError, HttpProxyFlavor, ListenEndpoint, Target, TargetOptions};
use gated_core::logging::http::{
    get_client_ip, log_request_error, log_request_result, span_for_request,
};
use gated_core::recordings::SessionRecordings;
use gated_core::{ConfigProvider, Services, SessionStateInit, State};
use gated_tls::{
    SingleCertResolver, TlsCertificateAndPrivateKey, TlsCertificateBundle, TlsPrivateKey,
};
use rustls::ServerConfig;
use tokio::sync::Mutex;
use tracing::*;

use crate::engine::{
    FlavorHook, build_http_client, injected_header_names, proxy_to_upstream as engine_proxy,
};
use crate::kubernetes::auth::validate_client_certificate;
use crate::kubernetes::client_certs::build_client_cert_verifier;
use crate::kubernetes::correlator::RequestCorrelator;
use crate::kubernetes::websocket::handle_websocket_request;
use crate::recording::start_recording;
use crate::resolver::{ResolverConfig, resolve_target};
use crate::session_handle::ApiSessionHandle;

const UNAUTHORIZED_BODY: &str = "unauthorized";

pub async fn run_server(
    services: Services,
    address: ListenEndpoint,
    base_domain: String,
    tls: bool,
) -> anyhow::Result<()> {
    let recordings = services.recordings.clone();
    let correlator = RequestCorrelator::new(&services);
    let resolver_config = Arc::new(ResolverConfig { base_domain });

    let app = Router::new()
        .fallback(handle_proxy_request)
        .layer(axum::middleware::from_fn(cors))
        .layer(Extension(recordings))
        .layer(Extension(services.clone()))
        .layer(Extension(correlator))
        .layer(Extension(resolver_config));

    // Plaintext mode: a TLS-terminating reverse proxy (Traefik / nsl) handles
    // TLS in front, so we serve HTTP here. mTLS client-cert auth is
    // unavailable in this mode (no TLS handshake to capture a cert from);
    // Bearer token and `?gated-token=` still work.
    if !tls {
        // A plaintext listener carries `?gated-token=` credentials and upstream
        // traffic in the clear. Binding it to a routable (non-loopback) address
        // exposes those over the network, so refuse unless the operator has
        // explicitly acknowledged a trusted TLS-terminating proxy in front via
        // `http.behind_proxy`.
        if !address.address().ip().is_loopback() {
            let behind_proxy = services.config.read().await.store.http.behind_proxy;
            guard_plaintext_nonloopback_bind(&address, behind_proxy)?;
        }
        info!(?address, "HTTP-proxy listener starting (plaintext)");
        serve(&address, None, app)
            .await
            .context("HTTP-proxy server error (plaintext)")?;
        return Ok(());
    }

    info!(?address, "HTTP-proxy listener starting");

    let certificate_and_key = {
        let config = services.config.read().await;
        let certificate_path = services
            .global_params
            .paths_relative_to()
            .join(&config.store.http.certificate);
        let key_path = services
            .global_params
            .paths_relative_to()
            .join(&config.store.http.key);

        TlsCertificateAndPrivateKey {
            certificate: TlsCertificateBundle::from_file(&certificate_path)
                .await
                .with_context(|| {
                    format!(
                        "reading TLS certificate from '{}'",
                        certificate_path.display()
                    )
                })?,
            private_key: TlsPrivateKey::from_file(&key_path).await.with_context(|| {
                format!("reading TLS private key from '{}'", key_path.display())
            })?,
        }
    };

    // Load the instance CA so presented client certificates can be
    // cryptographically verified (chain + proof-of-possession) during the TLS
    // handshake, rather than accepting any certificate.
    let ca_certificate_pem = {
        let db = services.db_required().await?;
        gated_db_entities::Parameters::Entity::get(&db)
            .await
            .context("loading instance CA certificate from parameters")?
            .ca_certificate_pem
    };

    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let client_cert_verifier = build_client_cert_verifier(&ca_certificate_pem, provider.clone())
        .context("configuring mTLS client certificate verifier")?;

    let tls_config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| anyhow::anyhow!("Failed to configure TLS protocol versions: {}", e))?
        .with_client_cert_verifier(client_cert_verifier)
        .with_cert_resolver(Arc::new(SingleCertResolver::new(certificate_and_key)));

    serve(&address, Some(Arc::new(tls_config)), app)
        .await
        .context("HTTP-proxy server error")?;

    Ok(())
}

/// An error answered with its status and message as plain text.
struct ProxyError(Response);

impl ProxyError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self((status, message.into()).into_response())
    }

    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, UNAUTHORIZED_BODY)
    }
}

impl From<GatedError> for ProxyError {
    fn from(error: GatedError) -> Self {
        Self(error.into_response())
    }
}

impl From<anyhow::Error> for ProxyError {
    fn from(error: anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        self.0
    }
}

const CORS_ALLOWED_METHODS: &str = "GET, POST, PUT, DELETE, HEAD, OPTIONS, CONNECT, PATCH, TRACE";

/// Answers preflight requests of any origin and lets every origin read the
/// proxied responses.
async fn cors(request: Request, next: Next) -> Response {
    let Some(origin) = request.headers().get(header::ORIGIN).cloned() else {
        return next.run(request).await;
    };

    if request.method() == Method::OPTIONS {
        let requests_a_method = request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.parse::<Method>().is_ok());
        if !requests_a_method {
            return (StatusCode::FORBIDDEN, "request-method not allowed").into_response();
        }
        let allowed_headers = request
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
            .cloned()
            .unwrap_or(HeaderValue::from_static("*"));
        return (
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, origin),
                (
                    header::ACCESS_CONTROL_MAX_AGE,
                    HeaderValue::from_static("86400"),
                ),
                (
                    header::ACCESS_CONTROL_ALLOW_METHODS,
                    HeaderValue::from_static(CORS_ALLOWED_METHODS),
                ),
                (header::ACCESS_CONTROL_ALLOW_HEADERS, allowed_headers),
            ],
            (),
        )
            .into_response();
    }

    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

async fn handle_proxy_request(
    Extension(recordings): Extension<Arc<Mutex<SessionRecordings>>>,
    Extension(correlator): Extension<Arc<Mutex<RequestCorrelator>>>,
    Extension(services): Extension<Services>,
    Extension(resolver_config): Extension<Arc<ResolverConfig>>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    request: Request,
) -> Result<Response, ProxyError> {
    let (req, body) = request.into_parts();
    let req = &req;
    let services = &services;

    let target = match resolve_target(req, &resolver_config, services).await {
        Ok(t) => t,
        Err(e) => {
            debug!(error = %e, "Target resolution failed");
            return Err(ProxyError::unauthorized());
        }
    };

    let TargetOptions::Http(_) = &target.options else {
        return Err(ProxyError::new(
            StatusCode::BAD_REQUEST,
            "Invalid target type for HTTP-proxy listener",
        ));
    };

    let user_info = authenticate_request(req, services).await?;

    {
        let mut cp = services.config_provider.lock().await;
        if !cp
            .authorize_target(&user_info.username, &target.name)
            .await
            .unwrap_or(false)
        {
            return Err(ProxyError::unauthorized());
        }
    }

    let path = req.uri.path().trim_start_matches('/').to_owned();
    dispatch(
        ws.ok(),
        req,
        body,
        target,
        user_info,
        &path,
        &correlator,
        services,
        &recordings,
    )
    .await
}

#[cfg(test)]
mod tests {
    use gated_common::http_headers::scrub_secret_query_params;

    async fn cors_response(request: http::request::Builder) -> axum::response::Response {
        use axum::routing::any;
        use tower::ServiceExt;

        axum::Router::new()
            .fallback(any(|| async { "proxied" }))
            .layer(axum::middleware::from_fn(super::cors))
            .oneshot(request.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn requests_without_an_origin_pass_through_untouched() {
        let response = cors_response(http::Request::builder().uri("/x")).await;
        assert_eq!(response.status(), http::StatusCode::OK);
        assert!(
            !response
                .headers()
                .contains_key("access-control-allow-origin")
        );
    }

    #[tokio::test]
    async fn cross_origin_responses_echo_the_origin() {
        let response = cors_response(
            http::Request::builder()
                .uri("/x")
                .header("origin", "https://app.example"),
        )
        .await;
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "https://app.example"
        );
        assert_eq!(response.headers()["vary"], "Origin");
    }

    #[tokio::test]
    async fn preflight_is_answered_without_reaching_the_target() {
        let response = cors_response(
            http::Request::builder()
                .method("OPTIONS")
                .uri("/x")
                .header("origin", "https://app.example")
                .header("access-control-request-method", "PUT")
                .header("access-control-request-headers", "x-custom"),
        )
        .await;
        assert_eq!(response.status(), http::StatusCode::OK);
        let headers = response.headers();
        assert_eq!(
            headers["access-control-allow-origin"],
            "https://app.example"
        );
        assert_eq!(headers["access-control-allow-headers"], "x-custom");
        assert_eq!(headers["access-control-max-age"], "86400");
        assert!(
            headers["access-control-allow-methods"]
                .to_str()
                .unwrap()
                .contains("PUT")
        );
        let body = axum::body::to_bytes(response.into_body(), 64)
            .await
            .unwrap();
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn preflight_without_a_requested_method_is_rejected() {
        let response = cors_response(
            http::Request::builder()
                .method("OPTIONS")
                .uri("/x")
                .header("origin", "https://app.example"),
        )
        .await;
        assert_eq!(response.status(), http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn scrubs_token_from_query() {
        let uri = "/foo?a=1&gated-token=deadbeef&b=2"
            .parse::<http::Uri>()
            .unwrap();
        let scrubbed = scrub_secret_query_params(&uri);
        assert_eq!(scrubbed.to_string(), "/foo?a=1&b=2");
        assert!(!scrubbed.to_string().contains("gated-token"));
        assert!(!scrubbed.to_string().contains("deadbeef"));
    }

    #[test]
    fn scrubs_lone_token() {
        let uri = "/foo?gated-token=secret".parse::<http::Uri>().unwrap();
        let scrubbed = scrub_secret_query_params(&uri);
        assert_eq!(scrubbed.to_string(), "/foo");
    }

    #[test]
    fn scrubs_ticket_secret() {
        let uri = "/foo?gated-ticket=secret&a=1".parse::<http::Uri>().unwrap();
        let scrubbed = scrub_secret_query_params(&uri);
        assert_eq!(scrubbed.to_string(), "/foo?a=1");
    }

    #[test]
    fn leaves_other_queries_untouched() {
        let uri = "/foo?a=1&b=2".parse::<http::Uri>().unwrap();
        assert_eq!(scrub_secret_query_params(&uri).to_string(), "/foo?a=1&b=2");

        let no_query = "/foo".parse::<http::Uri>().unwrap();
        assert_eq!(scrub_secret_query_params(&no_query).to_string(), "/foo");
    }
}

/// Authenticate by Bearer token first, falling back to client certificate.
/// Returns the symmetric 401 — clients cannot distinguish "wrong target"
/// from "wrong credential" from the response.
async fn authenticate_request(
    req: &Parts,
    services: &Services,
) -> Result<AuthStateUserInfo, ProxyError> {
    if let Some(auth_header) = req.headers.get(http::header::AUTHORIZATION)
        && let Ok(auth_str) = auth_header.to_str()
        && let Some(token) = auth_str.strip_prefix("Bearer ")
    {
        let mut cp = services.config_provider.lock().await;
        if let Ok(Some(user)) = cp.validate_api_token(token).await {
            return Ok((&user).into());
        }
    }

    // Browser-friendly fallback: `?gated-token=<secret>` in the query string.
    // A plain browser navigation can't set an Authorization header, so this
    // lets a copy-pasteable URL carry the API token. This server
    // scrubs `gated-token` from URLs before they are logged (see
    // `scrub_gated_token`), so the secret does not reach our request logs.
    // Residual risk remains on the client side — the token still lands in
    // browser history and any `Referer` header — so Bearer/mTLS should be
    // preferred for automation, and this fallback used only for interactive
    // browser access. API token secrets are URL-safe (hex), so no
    // percent-decoding is needed.
    if let Some(query) = req.uri.query() {
        for pair in query.split('&') {
            if let Some(token) = pair.strip_prefix("gated-token=") {
                let mut cp = services.config_provider.lock().await;
                if let Ok(Some(user)) = cp.validate_api_token(token).await {
                    return Ok((&user).into());
                }
            }
        }
    }

    if let Some(client_cert) = req
        .extensions
        .get::<ConnectionInfo>()
        .and_then(|info| info.peer_certificate.as_ref())
    {
        match validate_client_certificate(client_cert, services).await {
            Ok(Some(user_info)) => return Ok(user_info),
            Ok(None) => debug!("Client certificate provided but not found in database"),
            Err(e) => warn!(error = %e, "Error validating client certificate"),
        }
    }

    Err(ProxyError::unauthorized())
}

#[allow(clippy::too_many_arguments)]
async fn dispatch(
    ws: Option<WebSocketUpgrade>,
    req: &Parts,
    body: Body,
    target: Target,
    user_info: AuthStateUserInfo,
    path: &str,
    correlator: &Arc<Mutex<RequestCorrelator>>,
    services: &Services,
    recordings: &Arc<Mutex<SessionRecordings>>,
) -> Result<Response, ProxyError> {
    let db = gated_core::db_required(&services.db)
        .await
        .map_err(|e| ProxyError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let (http_options, account_id) =
        gated_core::account_credentials::http_options_with_account(&db, &target)
            .await
            .map_err(|e| ProxyError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let flavor = http_options.flavor;

    // Session handle.  Kubernetes flavor uses the correlator (kubectl
    // sends many requests within one logical session); Generic uses a
    // per-request session.
    let handle = match flavor {
        HttpProxyFlavor::Kubernetes => correlator
            .lock()
            .await
            .session_for_request(req, &user_info, &target.name)
            .await
            .map_err(|e: GatedError| {
                ProxyError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            })?,
        HttpProxyFlavor::Generic => {
            let ip = get_client_ip(req, Some(services)).await;
            State::register_session(
                &services.state,
                &crate::PROTOCOL_NAME,
                SessionStateInit {
                    remote_address: ip.and_then(|x| x.parse().ok()),
                    handle: Box::new(ApiSessionHandle),
                },
            )
            .await
            .map_err(|e: GatedError| {
                ProxyError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            })?
        }
    };

    let (session_id, log_span) = {
        let h = handle.lock().await;
        h.set_target(&target).await?;
        h.set_user_info(user_info.clone()).await?;
        (h.id(), span_for_request(req, Some(&*h)).await)
    };

    let result = async {
        let response = match (ws, flavor) {
            (Some(ws), HttpProxyFlavor::Kubernetes) => {
                handle_websocket_request(
                    ws,
                    req,
                    &http_options,
                    path,
                    session_id,
                    services,
                    recordings,
                )
                .await
            }
            _ => {
                let client = build_http_client(&http_options).map_err(GatedError::from)?;
                let injected = injected_header_names(&http_options.upstream_auth);

                let recorder_opt = {
                    let enabled = {
                        let config = services.config.read().await;
                        config.store.recordings.enable
                    };
                    if enabled {
                        start_recording(&session_id, recordings, flavor).await.ok()
                    } else {
                        None
                    }
                };

                engine_proxy(
                    req,
                    body,
                    &http_options.url,
                    &client,
                    FlavorHook::from(flavor),
                    &injected,
                    path,
                    recorder_opt,
                )
                .await
                .context("handling HTTP-proxy request")
            }
        };

        if let Some(account_id) = account_id {
            gated_core::account_credentials::update_account_last_used_at(&db, account_id)
                .await
                .map_err(|e| GatedError::Other(anyhow::anyhow!(e).into()))?;
        }

        let client_ip = get_client_ip(req, Some(services)).await;
        // Never log the credentials that may ride in the query.
        let logged_uri = scrub_secret_query_params(&req.uri);
        let response = response.inspect_err(|e| {
            log_request_error(&req.method, &logged_uri, client_ip.as_deref(), e);
        })?;

        handle.lock().await.audit_target_connected().await;
        log_request_result(
            &req.method,
            &logged_uri,
            client_ip.as_deref(),
            &response.status(),
        );

        Ok(response)
    }
    .instrument(log_span)
    .await;

    // Drop the per-request generic-flavor handle (the correlator owns
    // Kubernetes-flavor handles for the full session window).
    if flavor == HttpProxyFlavor::Generic {
        drop(handle);
    }

    result
}

/// Guard for a plaintext (`tls = false`) proxy listener bound to a non-loopback
/// address. Returns an error unless `behind_proxy` acknowledges a trusted
/// TLS-terminating front proxy; logs a cleartext-exposure warning when it does.
/// Loopback binds are handled by the caller and never reach here.
fn guard_plaintext_nonloopback_bind(
    address: &ListenEndpoint,
    behind_proxy: bool,
) -> anyhow::Result<()> {
    if !behind_proxy {
        anyhow::bail!(
            "refusing to bind the plaintext HTTP-proxy listener to non-loopback address \
             {address:?}: tokens and upstream traffic would travel in cleartext. Set \
             http.tls = true, bind a loopback address, or set http.behind_proxy = true if a \
             trusted TLS-terminating reverse proxy fronts this listener.",
        );
    }
    warn!(
        ?address,
        "HTTP-proxy plaintext listener bound to a non-loopback address with behind_proxy set: \
         tokens and upstream traffic are cleartext on the wire between the front proxy and this \
         listener — ensure that hop is trusted",
    );
    Ok(())
}

#[cfg(test)]
mod plaintext_bind_tests {
    use std::net::SocketAddr;

    use super::*;

    #[test]
    fn plaintext_nonloopback_bind_rejected_without_behind_proxy() {
        let addr: ListenEndpoint = "0.0.0.0:8888".parse::<SocketAddr>().unwrap().into();
        assert!(guard_plaintext_nonloopback_bind(&addr, false).is_err());
    }

    #[test]
    fn plaintext_nonloopback_bind_allowed_with_behind_proxy() {
        let addr: ListenEndpoint = "0.0.0.0:8888".parse::<SocketAddr>().unwrap().into();
        assert!(guard_plaintext_nonloopback_bind(&addr, true).is_ok());
    }
}
