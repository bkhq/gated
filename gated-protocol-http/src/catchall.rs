use poem::web::{Data, FromRequest, Redirect};
use poem::{handler, Body, IntoResponse, Request, Response};
use tracing::*;
use gated_common::{Target, TargetApiOptions, TargetOptions};
use gated_core::{ConfigProvider, Services};

use crate::api_proxy;
use crate::common::RequestAuthorization;

use gated_common::http_headers::X_GATED_TARGET;

pub fn target_select_redirect() -> Response {
    Redirect::temporary("/ui/").into_response()
}

#[handler]
pub async fn catchall_endpoint(
    req: &Request,
    body: Body,
    services: Data<&Services>,
) -> poem::Result<Response> {
    // Check for API proxy request (X-Gated-Target header with API target)
    if let Some((target, api_options, username)) =
        get_api_target_for_request(req, services.0).await?
    {
        let span = info_span!("", target=%target.name, kind="api");

        return async {
            api_proxy::proxy_api_request(
                req,
                body,
                &api_options,
                &username,
                services.0,
            )
            .await
            .map_err(|e| poem::Error::from_string(e.to_string(), poem::http::StatusCode::BAD_GATEWAY))
        }
        .instrument(span)
        .await;
    }

    // No HTTP proxy targets — redirect to the gateway UI
    Ok(target_select_redirect())
}

/// Check if this request targets an API proxy via X-Gated-Target header.
/// Returns (Target, TargetApiOptions, username) if this is an API proxy request.
async fn get_api_target_for_request(
    req: &Request,
    services: &Services,
) -> poem::Result<Option<(Target, TargetApiOptions, String)>> {
    // Must have X-Gated-Target header
    let target_name = match req.headers().get(&X_GATED_TARGET).and_then(|v| v.to_str().ok()) {
        Some(name) => name.to_string(),
        None => return Ok(None),
    };

    // Must have UserToken or session-based user auth (from X-Gated-Token or session cookie).
    // AdminToken is intentionally excluded — it has no associated username for RBAC checks.
    let auth = match Data::<&RequestAuthorization>::from_request_without_body(req).await {
        Ok(auth) => auth,
        Err(_) => return Ok(None),
    };

    let username = match *auth {
        RequestAuthorization::UserToken { ref username } => username.clone(),
        RequestAuthorization::Session(crate::common::SessionAuthorization::User(ref username)) => {
            username.clone()
        }
        _ => return Ok(None),
    };

    // Look up the target — must be an API target
    let mut config_provider = services.config_provider.lock().await;
    let targets = config_provider
        .list_targets()
        .await
        .map_err(|e| poem::error::InternalServerError(std::io::Error::new(std::io::ErrorKind::Other, format!("listing targets: {e}"))))?;

    let target = targets
        .iter()
        .find(|t| t.name == target_name && matches!(t.options, TargetOptions::Api(_)));

    let Some(target) = target else {
        return Ok(None);
    };

    let TargetOptions::Api(ref api_options) = target.options else {
        return Ok(None);
    };

    // RBAC check
    if !config_provider
        .authorize_target(&username, &target.name)
        .await
        .inspect_err(|e| warn!(error=%e, "authorize_target failed, denying access"))
        .unwrap_or(false)
    {
        return Err(poem::Error::from_string(
            format!("Access denied to target: {}", target_name),
            poem::http::StatusCode::FORBIDDEN,
        ));
    }

    Ok(Some((target.clone(), api_options.clone(), username)))
}
