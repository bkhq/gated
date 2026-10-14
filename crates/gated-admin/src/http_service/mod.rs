pub mod api;
mod catchall;
pub(crate) mod common;
mod management_audit;
mod middleware;
pub(crate) mod session;
mod session_handle;
pub mod spa;

use std::fmt::Debug;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::extract::{Request, State};
use axum::http::header::{
    CACHE_CONTROL, STRICT_TRANSPORT_SECURITY, X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS,
};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware::{Next, from_fn, from_fn_with_state};
use axum::response::Response;
use axum::routing::{any, get};
use axum::{Extension, Router};
use common::inject_request_authorization;
pub use common::{PROTOCOL_NAME, SsoLoginState};
use gated_common::http_headers::scrub_secret_query_params;
use gated_common::version::gated_version;
use gated_common::web::ErrorDetails;
use gated_common::web::server::{alpn_protocols, serve};
use gated_common::{GatedConfig, GlobalParams, ListenEndpoint};
use gated_core::logging::http::{
    get_client_ip, log_request_error, log_request_result, span_for_request,
};
use gated_core::{ProtocolServer, Services};
use gated_tls::{
    IntoTlsCertificateRelativePaths, RustlsSetupError, SniCertResolver,
    TlsCertificateAndPrivateKey, TlsCertificateBundle, TlsPrivateKey,
};
use rustls::ServerConfig;
use tokio::sync::Mutex;
use tracing::*;

use crate::http_service::common::{SESSION_COOKIE_NAME, page_auth, require_admin, require_auth};
use crate::http_service::middleware::{
    CookieHostMiddleware, DbLockMiddleware, cookie_host_middleware, db_lock_middleware,
    ticket_middleware,
};
use crate::http_service::session::{Session, SessionLayer, SessionStore, session_middleware};
use crate::{admin_api_app, user_api_router, with_openapi_routes};

pub struct HTTPProtocolServer {
    services: Services,
}

impl HTTPProtocolServer {
    pub async fn new(services: &Services) -> Result<Self> {
        Ok(HTTPProtocolServer {
            services: services.clone(),
        })
    }
}

async fn load_certificate_and_key<R: IntoTlsCertificateRelativePaths>(
    from: &R,
    params: &GlobalParams,
) -> Result<TlsCertificateAndPrivateKey, RustlsSetupError> {
    Ok(TlsCertificateAndPrivateKey {
        certificate: TlsCertificateBundle::from_file(
            params.paths_relative_to().join(from.certificate_path()),
        )
        .await?,
        private_key: TlsPrivateKey::from_file(params.paths_relative_to().join(from.key_path()))
            .await?,
    })
}

async fn make_rustls_config(config: &GatedConfig, params: &GlobalParams) -> Result<ServerConfig> {
    let certificate_and_key = load_certificate_and_key(&config.store.http, params)
        .await
        .with_context(|| {
            format!(
                "loading TLS certificate and key: {}",
                config.store.http.certificate,
            )
        })?;

    let mut resolver = SniCertResolver::new(certificate_and_key);
    for sni in &config.store.http.sni_certificates {
        let certificate_and_key = load_certificate_and_key(sni, params)
            .await
            .with_context(|| format!("loading SNI TLS certificate: {sni:?}",))?;

        for name in certificate_and_key.certificate.sni_names()? {
            debug!(?name, source=?sni, "Adding SNI certificate");
            resolver.add(name, certificate_and_key.clone());
        }
    }

    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut cfg = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .context("configuring TLS protocol versions")?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(resolver));
    cfg.alpn_protocols = alpn_protocols();
    Ok(cfg)
}

async fn cache_bust(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("must-revalidate,no-cache,no-store"),
    );
    response
}

async fn security_headers(
    State(tls_enabled): State<bool>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    if tls_enabled {
        headers.insert(
            STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}

async fn log_requests(State(services): State<Services>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    // Never log a ticket secret handed over as
    // `?gated-ticket=`.
    let url = scrub_secret_query_params(request.uri());
    let (parts, body) = request.into_parts();
    let client_ip = get_client_ip(&parts, Some(&services)).await;

    let response = next.run(Request::from_parts(parts, body)).await;

    match response.extensions().get::<ErrorDetails>() {
        Some(ErrorDetails(error)) => log_request_error(&method, &url, client_ip.as_deref(), error),
        None => log_request_result(&method, &url, client_ip.as_deref(), &response.status()),
    }
    response
}

/// Refreshes the management session of the request and runs it inside its
/// log span.
async fn track_session(request: Request, next: Next) -> Response {
    if let (Some(store), Some(session)) = (
        request.extensions().get::<Arc<Mutex<SessionStore>>>(),
        request.extensions().get::<Session>(),
    ) {
        store.lock().await.touch(session);
    }
    let (parts, body) = request.into_parts();
    let span = span_for_request(&parts, None).await;

    next.run(Request::from_parts(parts, body))
        .instrument(span)
        .await
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

impl ProtocolServer for HTTPProtocolServer {
    async fn run(self, address: ListenEndpoint) -> Result<()> {
        let session_store = SessionStore::new();
        let db = self.services.db.clone();

        let (cookie_max_age, session_max_age, tls_enabled, configured_cookie_domain) = {
            let config = self.services.config.read().await;
            (
                config.store.http.cookie_max_age,
                config.store.http.session_max_age,
                config.store.http.tls,
                config.store.http.cookie_domain.clone(),
            )
        };

        // Set cookie domain to base host (e.g., ".warp.tavahealth.com") so it works for
        // the base host and all its subdomains (e.g., "foo.warp.tavahealth.com").
        // This is more restrictive than using the parent domain and ensures cookies only
        // work for the base host and its subdomains, not sibling domains.
        let base_cookie_domain: Option<String> = if let Some(domain) = configured_cookie_domain {
            tracing::info!("Cookie domain configured explicitly: {}", domain);
            Some(domain)
        } else {
            let config = self.services.config.read().await;
            match config.construct_external_url(None, None) {
                Ok(url) => {
                    if let Some(host) = url.host_str() {
                        let domain = format!(".{}", host);
                        tracing::info!(
                            "Cookie domain configured: {} (base host: {}) - cookies will work for {} and all its subdomains",
                            domain,
                            host,
                            host
                        );
                        Some(domain)
                    } else {
                        tracing::warn!(
                            "Failed to determine cookie domain - external_host may not be configured. Cookies will be scoped to request host, which may prevent cross-subdomain authentication."
                        );
                        None
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "Failed to construct external URL for cookie domain: {:?}. Cookies will be scoped to request host.",
                        e
                    );
                    None
                }
            }
        };

        let encryption_runtime = self.services.encryption_runtime.read().await.clone();

        let user_api = with_openapi_routes(
            user_api_router(gated_version())
                .fallback(not_found)
                .layer(from_fn(cache_bust)),
        )
        .route(
            "/ssh/terminal/{target_name}",
            get(api::ssh_terminal::api_ssh_terminal).route_layer(from_fn(require_auth)),
        )
        .route(
            "/mysql/terminal/{target_name}",
            get(api::db_terminal::api_mysql_terminal).route_layer(from_fn(require_auth)),
        )
        .route(
            "/postgres/terminal/{target_name}",
            get(api::db_terminal::api_postgres_terminal).route_layer(from_fn(require_auth)),
        )
        .route(
            "/auth/web-auth-requests/stream",
            get(api::auth::api_get_web_auth_requests_stream).route_layer(from_fn(require_auth)),
        )
        .nest("/admin/encryption", api::encryption::routes());
        let admin_api = admin_api_app(&self.services)
            .fallback(not_found)
            .layer(from_fn(require_admin))
            .layer(from_fn(require_auth))
            .layer(from_fn(cache_bust));

        let session_layer = SessionLayer::new(SESSION_COOKIE_NAME, tls_enabled, cookie_max_age);
        let app = Router::new()
            .nest("/api", user_api)
            .nest("/admin/api", admin_api)
            .merge(spa::routes())
            .fallback(any(catchall::catchall_endpoint).layer(from_fn(page_auth)))
            .layer(from_fn_with_state(self.services.clone(), log_requests))
            .layer(from_fn(management_audit::audit_request))
            .layer(from_fn(inject_request_authorization))
            .layer(from_fn(track_session))
            .layer(from_fn(ticket_middleware))
            .layer(from_fn_with_state(
                DbLockMiddleware::new(
                    encryption_runtime,
                    vec![
                        "/api/admin/encryption/".to_owned(),
                        "/admin/api/encryption/".to_owned(),
                        "/healthz".to_owned(),
                        "/ui".to_owned(),
                        "/assets".to_owned(),
                    ],
                ),
                db_lock_middleware,
            ))
            .layer(from_fn_with_state(
                session_layer.clone(),
                session_middleware,
            ))
            .layer(from_fn_with_state(
                CookieHostMiddleware::new(base_cookie_domain),
                cookie_host_middleware,
            ))
            .layer(Extension(self.services.clone()))
            .layer(Extension(session_store.clone()))
            .layer(Extension(db))
            .layer(from_fn_with_state(tls_enabled, security_headers));

        tokio::spawn(async move {
            loop {
                session_store.lock().await.vacuum(session_max_age).await;
                session_layer.vacuum();
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });

        let tls_config = if tls_enabled {
            let config = self.services.config.read().await;
            Some(Arc::new(
                make_rustls_config(&config, &self.services.global_params)
                    .await
                    .context("rustls setup")?,
            ))
        } else {
            info!("TLS is disabled for HTTP listener");
            None
        };

        serve(&address, tls_config, app).await?;

        Ok(())
    }

    fn name(&self) -> &'static str {
        "HTTP"
    }
}

impl Debug for HTTPProtocolServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTPProtocolServer")
    }
}
