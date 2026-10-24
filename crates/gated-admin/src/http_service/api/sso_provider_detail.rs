use crate::http_service::session::Session;
use axum::extract::{Path, Query};
use axum::http::request::Parts;
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use gated_sso::{SsoClient, SsoLoginRequest};
use serde::{Deserialize, Serialize};
use tracing::*;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;

#[derive(Serialize, ToSchema)]
struct StartSsoResponseParams {
    url: String,
}

api_response! {
    #[allow(clippy::large_enum_variant)]
    enum StartSsoResponse {
        #[oai(status = 200)]
        Ok(Json<StartSsoResponseParams>),
        #[oai(status = 404)]
        NotFound,
    }
}

pub static SSO_CONTEXT_SESSION_KEY: &str = "sso_request";

#[derive(Debug, Serialize, Deserialize)]
pub struct SsoContext {
    pub provider: String,
    pub request: SsoLoginRequest,
    pub next_url: Option<String>,
    pub supports_single_logout: bool,
    pub return_host: Option<String>,
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct StartSsoQuery {
    next: Option<String>,
}

#[utoipa::path(
    get,
    path = "/sso/providers/{name}/start",
    operation_id = "start_sso",
    params(StartSsoQuery)
)]
async fn api_start_sso(
    name: Path<String>,
    req: Parts,
    session: Session,
    services: Data<Services>,
    Query(query): Query<StartSsoQuery>,
) -> Result<StartSsoResponse, GatedError> {
    let StartSsoQuery { next } = query;
    let config = services.config.read().await;

    let name = name.0;

    let Some(provider_config) = config.store.sso_providers.iter().find(|p| p.name == *name) else {
        return Ok(StartSsoResponse::NotFound);
    };
    let mut return_url = config.construct_external_url(
        Some(&req),
        provider_config.return_domain_whitelist.as_deref(),
    )?;
    return_url.set_path("api/sso/return");
    debug!("Return URL: {}", &return_url);

    let client = SsoClient::new(provider_config.provider.clone())?;

    let sso_req = client.start_login(return_url.to_string()).await?;
    let return_host = req
        .headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .map(|h| h.to_string());

    let url = sso_req.auth_url().to_string();
    session.set(
        SSO_CONTEXT_SESSION_KEY,
        SsoContext {
            provider: name,
            request: sso_req,
            next_url: next.clone(),
            supports_single_logout: client.supports_single_logout().await?,
            return_host,
        },
    );

    Ok(StartSsoResponse::Ok(Json(StartSsoResponseParams { url })))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_start_sso,)
}
