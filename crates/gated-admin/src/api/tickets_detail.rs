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
    enum DeleteTicketResponse {
        #[oai(status = 204)]
        Deleted,

        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(delete, path = "/tickets/{id}", operation_id = "delete_ticket")]
async fn api_delete_ticket(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteTicketResponse, GatedError> {
    use gated_db_entities::Ticket;
    let db = gated_core::db_required(&db).await?;

    let ticket = Ticket::Entity::find_by_id(id.0).one(&db).await?;

    match ticket {
        Some(ticket) => {
            ticket.delete(&db).await?;
            Ok(DeleteTicketResponse::Deleted)
        }
        None => Ok(DeleteTicketResponse::NotFound),
    }
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_delete_ticket,)
}
