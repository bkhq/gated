use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use russh::keys::PublicKeyBase64;
use serde::Serialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct SSHKey {
    pub kind: String,
    pub public_key_base64: String,
}

api_response! {
    enum GetSSHOwnKeysResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<SSHKey>>),
    }
}

#[utoipa::path(get, path = "/ssh/own-keys", operation_id = "get_ssh_own_keys")]
async fn api_ssh_get_own_keys(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSSHOwnKeysResponse, GatedError> {
    let config = services.config.read().await;
    let keys = gated_protocol_ssh::load_keys(&config, &services.global_params, "client")?;

    let keys = keys
        .into_iter()
        .map(|k| SSHKey {
            kind: k.algorithm().to_string(),
            public_key_base64: k.public_key_base64(),
        })
        .collect();
    Ok(GetSSHOwnKeysResponse::Ok(Json(keys)))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_ssh_get_own_keys,)
}
