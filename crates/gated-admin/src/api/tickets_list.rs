use anyhow::Context;
use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::helpers::hash::generate_ticket_secret;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::Ticket;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, EntityTrait};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

api_response! {
    enum GetTicketsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<Ticket::Model>>),
    }
}

#[derive(Deserialize, ToSchema)]
struct CreateTicketRequest {
    username: String,
    target_name: String,
    expiry: Option<DateTime<Utc>>,
    number_of_uses: Option<i16>,
    description: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct TicketAndSecret {
    ticket: Ticket::Model,
    secret: String,
}

api_response! {
    enum CreateTicketResponse {
        #[oai(status = 201)]
        Created(Json<TicketAndSecret>),

        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

#[utoipa::path(get, path = "/tickets", operation_id = "get_tickets")]
async fn api_get_all_tickets(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetTicketsResponse, GatedError> {
    use gated_db_entities::Ticket;

    let db = gated_core::db_required(&db).await?;
    let tickets = Ticket::Entity::find().all(&db).await?;
    Ok(GetTicketsResponse::Ok(Json(tickets)))
}

#[utoipa::path(post, path = "/tickets", operation_id = "create_ticket")]
async fn api_create_ticket(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<CreateTicketRequest>,
) -> Result<CreateTicketResponse, GatedError> {
    use gated_db_entities::Ticket;

    if body.username.is_empty() {
        return Ok(CreateTicketResponse::BadRequest(Json("username".into())));
    }
    if body.target_name.is_empty() {
        return Ok(CreateTicketResponse::BadRequest(Json("target_name".into())));
    }

    let db = gated_core::db_required(&db).await?;
    let secret = generate_ticket_secret();
    let values = Ticket::ActiveModel {
        id: Set(Uuid::new_v4()),
        secret: Set(secret.expose_secret().to_string()),
        username: Set(body.username.clone()),
        target: Set(body.target_name.clone()),
        created: Set(chrono::Utc::now()),
        expiry: Set(body.expiry),
        uses_left: Set(body.number_of_uses),
        description: Set(body.description.clone().unwrap_or_default()),
    };

    let ticket = values.insert(&db).await.context("Error saving ticket")?;

    Ok(CreateTicketResponse::Created(Json(TicketAndSecret {
        secret: secret.expose_secret().to_string(),
        ticket,
    })))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all_tickets, api_create_ticket,)
}
