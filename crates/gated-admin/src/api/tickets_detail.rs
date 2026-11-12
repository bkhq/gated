use axum::extract::Path;
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::{Services, SharedDatabaseConnection};
use sea_orm::{EntityTrait, ModelTrait};
use std::sync::Arc;
use tokio::sync::Mutex;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;
use super::tickets_list::TicketAndSecret;
use crate::http_service::api::tickets::rotate_ticket;
use crate::http_service::session::SessionStore;

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

api_response! {
    enum RotateTicketResponse {
        #[oai(status = 200)]
        Rotated(Json<TicketAndSecret>),

        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(post, path = "/tickets/{id}/rotate", operation_id = "rotate_ticket")]
async fn api_rotate_ticket(
    id: Path<Uuid>,
    services: Data<Services>,
    store: Data<Arc<Mutex<SessionStore>>>,
    _sec_scheme: AnySecurityScheme,
) -> Result<RotateTicketResponse, GatedError> {
    use gated_db_entities::Ticket;
    let db = services.db_required().await?;
    let Some(ticket) = Ticket::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(RotateTicketResponse::NotFound);
    };
    drop(db);
    let (ticket, secret) = rotate_ticket(&services, &store, ticket).await?;
    Ok(RotateTicketResponse::Rotated(Json(TicketAndSecret {
        ticket,
        secret: secret.expose_secret().to_string(),
    })))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_delete_ticket, api_rotate_ticket,)
}
