use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use serde::Deserialize;
use std::str::FromStr;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use anyhow::Context;
use gated_common::GatedError;
use gated_core::SharedDatabaseConnection;
use gated_db_entities::KnownHost;
use russh::keys::{Algorithm, PublicKey};
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use uuid::Uuid;

use super::AnySecurityScheme;

api_response! {
    enum GetSSHKnownHostsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<KnownHost::Model>>),
    }
}

api_response! {
    enum AddSshKnownHostResponse {
        #[oai(status = 200)]
        Ok(Json<KnownHost::Model>),
    }
}

#[derive(Deserialize, ToSchema)]
struct AddSshKnownHostRequest {
    host: String,
    port: i32,
    key_type: String,
    key_base64: String,
}

#[utoipa::path(post, path = "/ssh/known-hosts", operation_id = "add_ssh_known_host")]
async fn add_ssh_known_host(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<AddSshKnownHostRequest>,
) -> Result<AddSshKnownHostResponse, GatedError> {
    use gated_db_entities::KnownHost;

    // Validate
    Algorithm::from_str(&body.key_type).context("parsing key type")?;
    PublicKey::from_openssh(&format!("{} {}", body.key_type, body.key_base64))
        .context("parsing key")?;

    let db = gated_core::db_required(&db).await?;
    let model = KnownHost::ActiveModel {
        id: Set(Uuid::new_v4()),
        host: Set(body.host.clone()),
        port: Set(body.port),
        key_type: Set(body.key_type.clone()),
        key_base64: Set(body.key_base64.clone()),
    }
    .insert(&db)
    .await?;
    Ok(AddSshKnownHostResponse::Ok(Json(model)))
}

#[utoipa::path(get, path = "/ssh/known-hosts", operation_id = "get_ssh_known_hosts")]
async fn get_ssh_known_hosts(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSSHKnownHostsResponse, GatedError> {
    use gated_db_entities::KnownHost;

    let db = gated_core::db_required(&db).await?;
    let hosts = KnownHost::Entity::find().all(&db).await?;
    Ok(GetSSHKnownHostsResponse::Ok(Json(hosts)))
}

pub fn router() -> OpenApiRouter {
    api_routes!(add_ssh_known_host, get_ssh_known_hosts,)
}
