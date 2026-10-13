use anyhow::Context;
use gated_common::version::gated_version;
use gated_core::{ConfigProvider, Services};
use gated_db_entities::Parameters;
use poem::session::Session;
use poem::web::Data;
use poem::Request;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use serde::Serialize;

use crate::http_service::common::{
    is_user_admin, RequestAuthorization, SessionAuthorization, SessionExt,
};

pub struct Api;

#[derive(Serialize, Object)]
pub struct PortsInfo {
    ssh: Option<u16>,
    http: Option<u16>,
    mysql: Option<u16>,
    postgres: Option<u16>,
    kubernetes: Option<u16>,
}

#[derive(Serialize, Object, Debug)]
pub struct SetupState {
    has_targets: bool,
    has_users: bool,
}

impl SetupState {
    pub fn completed(&self) -> bool {
        self.has_targets && self.has_users
    }
}

#[derive(Serialize, Object)]
pub struct Info {
    version: Option<String>,
    username: Option<String>,
    admin: bool,
    selected_target: Option<String>,
    external_host: Option<String>,
    ports: PortsInfo,
    minimize_password_login: bool,
    authorized_via_ticket: bool,
    authorized_via_sso_with_single_logout: bool,
    own_credential_management_allowed: bool,
    setup_state: Option<SetupState>,
    /// Base domain of the HTTP-proxy listener (`<target>.<base_domain>`),
    /// when the proxy is enabled and a base domain is configured. Lets the
    /// frontend build a per-target proxy URL. `None` if the proxy is off or
    /// has no base domain.
    http_proxy_base_domain: Option<String>,
    /// When true, the web terminal renders a frontend-only operator-identity +
    /// timestamp watermark overlay. Defaults to false.
    terminal_watermark_enabled: bool,
    /// Configured site title; `None` means the built-in "Gated". Public so
    /// the login page can show it.
    site_title: Option<String>,
}

#[derive(ApiResponse)]
enum InstanceInfoResponse {
    #[oai(status = 200)]
    Ok(Json<Info>),
}

#[OpenApi]
impl Api {
    #[oai(path = "/info", method = "get", operation_id = "get_info")]
    async fn api_get_info(
        &self,
        req: &Request,
        session: &Session,
        services: Data<&Services>,
        request_authorization: Option<Data<&RequestAuthorization>>,
    ) -> poem::Result<InstanceInfoResponse> {
        let config = services.config.read().await;
        let external_host = config
            .construct_external_url(Some(req), None)
            .ok()
            .as_ref()
            .and_then(|x| x.host())
            .map(|x| x.to_string());

        let parameters = {
            Parameters::Entity::get(&services.db_required().await?)
                .await
                .context("loading parameters")?
        };

        let user_is_admin = if let Some(auth) = &request_authorization {
            is_user_admin(req, auth).await?
        } else {
            false
        };

        let setup_state = if user_is_admin {
            let (users, targets) = {
                let mut p = services.config_provider.lock().await;
                let users = p.list_users().await?;
                let targets = p.list_targets().await?;
                (users, targets)
            };
            let state = SetupState {
                has_targets: targets.len() > 1,
                has_users: users.len() > 1,
            };
            if !state.completed() {
                Some(state)
            } else {
                None
            }
        } else {
            None
        };

        let authenticated = request_authorization.is_some();

        Ok(InstanceInfoResponse::Ok(Json(Info {
            version: authenticated.then(|| gated_version().to_string()),
            username: session.get_username(),
            admin: user_is_admin,
            selected_target: session.get_target_name(),
            external_host,
            minimize_password_login: parameters.minimize_password_login,
            authorized_via_ticket: matches!(
                session.get_auth(),
                Some(SessionAuthorization::Ticket { .. })
            ),
            authorized_via_sso_with_single_logout: session
                .get_sso_login_state()
                .is_some_and(|state| state.supports_single_logout),
            ports: match request_authorization {
                Some(_) => PortsInfo {
                    ssh: if config.store.ssh.enable {
                        Some(config.store.ssh.external_port())
                    } else {
                        None
                    },
                    http: Some(config.store.http.external_port()),
                    mysql: if config.store.mysql.enable {
                        Some(config.store.mysql.external_port())
                    } else {
                        None
                    },
                    postgres: if config.store.postgres.enable {
                        Some(config.store.postgres.external_port())
                    } else {
                        None
                    },
                    kubernetes: if config.store.proxy.enable {
                        Some(config.store.proxy.external_port())
                    } else {
                        None
                    },
                },
                None => PortsInfo {
                    ssh: None,
                    http: None,
                    mysql: None,
                    postgres: None,
                    kubernetes: None,
                },
            },
            own_credential_management_allowed: parameters.allow_own_credential_management,
            setup_state,
            // Intentionally exposed to authenticated users. The
            // connect-URL flow needs it so any user with an HTTP-proxy target
            // (not just admins) can build a `<target>.<base_domain>` URL, so it
            // is NOT gated to admins. The only value disclosed is the public
            // proxy base domain — the DNS suffix clients already connect to —
            // which carries nothing sensitive. It is withheld from
            // unauthenticated requests for consistency with the other fields.
            http_proxy_base_domain: authenticated
                .then(|| {
                    (config.store.proxy.enable && !config.store.proxy.base_domain.is_empty())
                        .then(|| config.store.proxy.base_domain.clone())
                })
                .flatten(),
            terminal_watermark_enabled: parameters.terminal_watermark_enabled,
            site_title: parameters.site_title.clone(),
        })))
    }
}
