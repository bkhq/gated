use axum::extract::Path;
use gated_common::GatedError;
use gated_common::web::Data;
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use sea_orm::{EntityTrait, ModelTrait};
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;
api_response! {
    enum DeleteSSHKnownHostResponse {
        #[oai(status = 204)]
        Deleted,

        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    delete,
    path = "/ssh/known-hosts/{id}",
    operation_id = "delete_ssh_known_host"
)]
async fn api_ssh_delete_known_host(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteSSHKnownHostResponse, GatedError> {
    use gated_db_entities::KnownHost;
    let db = gated_core::db_required(&db).await?;

    let known_host = KnownHost::Entity::find_by_id(id.0).one(&db).await?;

    match known_host {
        Some(known_host) => {
            known_host.delete(&db).await?;
            Ok(DeleteSSHKnownHostResponse::Deleted)
        }
        None => Ok(DeleteSSHKnownHostResponse::NotFound),
    }
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_ssh_delete_known_host,)
}
