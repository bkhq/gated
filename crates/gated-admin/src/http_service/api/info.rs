use crate::http_service::session::Session;
use anyhow::Context;
use axum::http::request::Parts;
use gated_common::GatedError;
use gated_common::version::gated_version;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::{ConfigProvider, Services};
use gated_db_entities::Parameters;
use serde::Serialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use crate::http_service::common::{
    RequestAuthorization, SessionAuthorization, SessionExt, is_user_admin,
};

#[derive(Serialize, ToSchema)]
pub struct PortsInfo {
    ssh: Option<u16>,
    http: Option<u16>,
    mysql: Option<u16>,
    postgres: Option<u16>,
    kubernetes: Option<u16>,
}

#[derive(Serialize, Debug, ToSchema)]
pub struct SetupState {
    has_targets: bool,
    has_users: bool,
}

impl SetupState {
    pub fn completed(&self) -> bool {
        self.has_targets && self.has_users
    }
}

#[derive(Serialize, ToSchema)]
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

api_response! {
    enum InstanceInfoResponse {
        #[oai(status = 200)]
        Ok(Json<Info>),
    }
}

#[utoipa::path(get, path = "/info", operation_id = "get_info")]
async fn api_get_info(
    req: Parts,
    session: Session,
    services: Data<Services>,
    request_authorization: Option<Data<RequestAuthorization>>,
) -> Result<InstanceInfoResponse, GatedError> {
    let config = services.config.read().await;
    let external_host = config
        .construct_external_url(Some(&req), None)
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
        is_user_admin(&services, auth).await?
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
                http: Some(config.store.admin.external_port()),
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
                kubernetes: if config.store.http.enable {
                    Some(config.store.http.external_port())
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
                (config.store.http.enable && !config.store.http.base_domain.is_empty())
                    .then(|| config.store.http.base_domain.clone())
            })
            .flatten(),
        terminal_watermark_enabled: parameters.terminal_watermark_enabled,
        site_title: parameters.site_title.clone(),
    })))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_info,)
}
