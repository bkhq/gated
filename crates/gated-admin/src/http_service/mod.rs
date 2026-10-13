pub mod api;
mod catchall;
pub(crate) mod common;
mod error;
mod management_audit;
mod middleware;
pub(crate) mod session;
mod session_handle;
pub mod spa;

use std::fmt::Debug;
use std::sync::Arc;
use std::time::Duration;

use crate::admin_api_app;
use crate::http_service::spa::SpaEndpoint;
use anyhow::{Context, Result};
use common::inject_request_authorization;
pub use common::{SsoLoginState, PROTOCOL_NAME};
use gated_common::http_headers::scrub_secret_query_params;
use gated_common::version::gated_version;
use gated_common::{GatedConfig, GlobalParams, ListenEndpoint};
use gated_core::logging::http::{
    get_client_ip, log_request_error, log_request_result, span_for_request,
};
use gated_core::{ProtocolServer, Services};
use gated_tls::{
    IntoTlsCertificateRelativePaths, RustlsSetupError, TlsCertificateAndPrivateKey,
    TlsCertificateBundle, TlsPrivateKey,
};
use http::HeaderValue;
use poem::listener::{Listener, RustlsConfig};
use poem::middleware::SetHeader;
use poem::session::{CookieConfig, MemoryStorage, ServerSession};
use poem::web::Data;
use poem::{Endpoint, EndpointExt, FromRequest, IntoEndpoint, IntoResponse, Route, Server};
use poem_openapi::OpenApiService;
use tokio::sync::Mutex;
use tracing::*;

use crate::http_service::common::{
    endpoint_admin_auth, endpoint_auth, page_auth, SESSION_COOKIE_NAME,
};
use crate::http_service::error::error_page;
use crate::http_service::middleware::{CookieHostMiddleware, DbLockMiddleware, TicketMiddleware};
use crate::http_service::session::{SessionStore, SharedSessionStorage};

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

fn make_session_storage() -> SharedSessionStorage {
    SharedSessionStorage(Arc::new(Mutex::new(Box::<MemoryStorage>::default())))
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

async fn make_rustls_config(config: &GatedConfig, params: &GlobalParams) -> Result<RustlsConfig> {
    let certificate_and_key = load_certificate_and_key(&config.store.http, params)
        .await
        .with_context(|| {
            format!(
                "loading TLS certificate and key: {}",
                config.store.http.certificate,
            )
        })?;

    let mut cfg = RustlsConfig::new().fallback(certificate_and_key.into());
    for sni in &config.store.http.sni_certificates {
        let certificate_and_key = load_certificate_and_key(sni, params)
            .await
            .with_context(|| format!("loading SNI TLS certificate: {sni:?}",))?;

        for name in certificate_and_key.certificate.sni_names()? {
            debug!(?name, source=?sni, "Adding SNI certificate");
            cfg = cfg.certificate(name, certificate_and_key.clone().into());
        }
    }
    Ok(cfg)
}

impl ProtocolServer for HTTPProtocolServer {
    async fn run(self, address: ListenEndpoint) -> Result<()> {
        let session_storage = make_session_storage();
        let session_store = SessionStore::new();
        let db = self.services.db.clone();

        let cache_bust = || {
            SetHeader::new().overriding(
                http::header::CACHE_CONTROL,
                HeaderValue::from_static("must-revalidate,no-cache,no-store"),
            )
        };

        let _cache_static = || {
            SetHeader::new().overriding(
                http::header::CACHE_CONTROL,
                HeaderValue::from_static("max-age=86400"),
            )
        };

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
                        tracing::warn!("Failed to determine cookie domain - external_host may not be configured. Cookies will be scoped to request host, which may prevent cross-subdomain authentication.");
                        None
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to construct external URL for cookie domain: {:?}. Cookies will be scoped to request host.", e);
                    None
                }
            }
        };

        let services_for_routes = self.services.clone();
        let encryption_runtime = self.services.encryption_runtime.read().await.clone();
        let api_service = {
            OpenApiService::new(
                crate::http_service::api::get(),
                "Gated user API",
                gated_version(),
            )
            .server("/api")
        };
        let openapi_ui_route = api_service.stoplight_elements();
        let openapi_spec_route = api_service.spec_endpoint();
        let admin_api_app = admin_api_app(&self.services).into_endpoint();

        let app = Route::new()
            .nest("/api/admin/encryption", api::encryption::routes())
            .nest("/api/playground", openapi_ui_route)
            .nest("/api", api_service.with(cache_bust()))
            .nest("/api/openapi.json", openapi_spec_route)
            .nest(
                "/admin/api",
                endpoint_auth(endpoint_admin_auth(admin_api_app)).with(cache_bust()),
            )
            .nest("/ui", SpaEndpoint::new())
            .at(
                "/api/ssh/terminal/:target_name",
                endpoint_auth(api::ssh_terminal::api_ssh_terminal),
            )
            .at(
                "/api/mysql/terminal/:target_name",
                endpoint_auth(api::db_terminal::api_mysql_terminal),
            )
            .at(
                "/api/postgres/terminal/:target_name",
                endpoint_auth(api::db_terminal::api_postgres_terminal),
            )
            .at(
                "/api/auth/web-auth-requests/stream",
                endpoint_auth(api::auth::api_get_web_auth_requests_stream),
            )
            .nest_no_strip(
                "/",
                page_auth(catchall::catchall_endpoint).around(move |ep, req| async move {
                    Ok(match ep.call(req).await {
                        Ok(response) => response.into_response(),
                        Err(error) => error_page(error).into_response(),
                    })
                }),
            )
            .around({
                let services = services_for_routes.clone();
                move |ep, req| {
                    let services = services.clone();
                    async move {
                        let method = req.method().clone();
                        // Never log a ticket secret handed over as
                        // `?gated-ticket=`.
                        let url = scrub_secret_query_params(req.original_uri());
                        let client_ip = get_client_ip(&req, Some(&services)).await;

                        let response = ep.call(req).await.inspect_err(|e| {
                            log_request_error(&method, &url, client_ip.as_deref(), e);
                        })?;

                        log_request_result(&method, &url, client_ip.as_deref(), &response.status());
                        Ok(response)
                    }
                }
            })
            .around(management_audit::audit_request)
            .around(inject_request_authorization)
            .around(move |ep, req| async move {
                let sm = Data::<&Arc<Mutex<SessionStore>>>::from_request_without_body(&req)
                    .await?
                    .clone();

                let req = { sm.lock().await.process_request(req).await? };
                let span = span_for_request(&req, None).await?;

                ep.call(req).instrument(span).await
            })
            .with(TicketMiddleware::new())
            .with(DbLockMiddleware::new(
                encryption_runtime,
                vec![
                    "/api/admin/encryption/".to_owned(),
                    "/admin/api/encryption/".to_owned(),
                    "/healthz".to_owned(),
                    "/ui".to_owned(),
                    "/assets".to_owned(),
                ],
            ))
            .with(ServerSession::new(
                CookieConfig::default()
                    .secure(tls_enabled)
                    .max_age(cookie_max_age)
                    .name(SESSION_COOKIE_NAME),
                session_storage.clone(),
            ))
            .with(CookieHostMiddleware::new(base_cookie_domain))
            .data(self.services.clone())
            .data(session_store.clone())
            .data(session_storage)
            .data(db);

        tokio::spawn(async move {
            loop {
                session_store.lock().await.vacuum(session_max_age).await;
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });

        let app = app.with(
            SetHeader::new()
                .overriding(http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .overriding(http::header::X_FRAME_OPTIONS, "DENY")
                .overriding(
                    http::header::HeaderName::from_static("referrer-policy"),
                    "strict-origin-when-cross-origin",
                ),
        );

        if tls_enabled {
            let app = app.with(
                SetHeader::new()
                    .overriding(http::header::STRICT_TRANSPORT_SECURITY, "max-age=31536000"),
            );

            let rustls_config = {
                let config = self.services.config.read().await;
                make_rustls_config(&config, &self.services.global_params)
                    .await
                    .context("rustls setup")?
            };

            Server::new(address.poem_listener().await?.rustls(rustls_config))
                .run(app)
                .await?;
        } else {
            info!("TLS is disabled for HTTP listener");
            Server::new(address.poem_listener().await?).run(app).await?;
        }

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
