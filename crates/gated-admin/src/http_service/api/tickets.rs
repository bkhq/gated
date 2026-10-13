use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::helpers::hash::generate_ticket_secret;
use gated_core::{ConfigProvider, Services};
use gated_db_entities::Ticket;
use poem::web::Data;
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use uuid::Uuid;

use super::common::{get_user, is_ticket_auth};
use crate::http_service::common::{RequestAuthorization, endpoint_auth};

pub struct Api;

#[derive(Object)]
struct NewProfileTicket {
    target_name: String,
    expiry: Option<DateTime<Utc>>,
    number_of_uses: Option<i16>,
    description: Option<String>,
}

#[derive(Object)]
struct ExistingProfileTicket {
    id: Uuid,
    target: String,
    description: String,
    uses_left: Option<i16>,
    expiry: Option<DateTime<Utc>>,
    created: DateTime<Utc>,
}

impl From<Ticket::Model> for ExistingProfileTicket {
    fn from(t: Ticket::Model) -> Self {
        Self {
            id: t.id,
            target: t.target,
            description: t.description,
            uses_left: t.uses_left,
            expiry: t.expiry,
            created: t.created,
        }
    }
}

#[derive(Object)]
struct ProfileTicketAndSecret {
    ticket: ExistingProfileTicket,
    secret: String,
}

#[derive(ApiResponse)]
enum GetTicketsResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<ExistingProfileTicket>>),
    #[oai(status = 401)]
    Unauthorized,
}

#[derive(ApiResponse)]
enum CreateTicketResponse {
    #[oai(status = 201)]
    Created(Json<ProfileTicketAndSecret>),
    #[oai(status = 400)]
    BadRequest(Json<String>),
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 403)]
    Forbidden(Json<String>),
}

#[derive(ApiResponse)]
enum DeleteTicketResponse {
    #[oai(status = 204)]
    Deleted,
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 404)]
    NotFound,
}

#[OpenApi]
impl Api {
    #[oai(
        path = "/profile/tickets",
        method = "get",
        operation_id = "get_my_tickets",
        transform = "endpoint_auth"
    )]
    async fn api_get_tickets(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
    ) -> Result<GetTicketsResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(*auth, &db).await? else {
            return Ok(GetTicketsResponse::Unauthorized);
        };

        let tickets = Ticket::Entity::find()
            .filter(Ticket::Column::Username.eq(user_model.username))
            .order_by_desc(Ticket::Column::Created)
            .all(&db)
            .await?;

        Ok(GetTicketsResponse::Ok(Json(
            tickets.into_iter().map(Into::into).collect(),
        )))
    }

    #[oai(
        path = "/profile/tickets",
        method = "post",
        operation_id = "create_my_ticket",
        transform = "endpoint_auth"
    )]
    async fn api_create_ticket(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        body: Json<NewProfileTicket>,
    ) -> Result<CreateTicketResponse, GatedError> {
        if is_ticket_auth(&auth) {
            return Ok(CreateTicketResponse::Forbidden(Json(
                "ticket auth cannot mint new tickets".into(),
            )));
        }

        if body.target_name.trim().is_empty() {
            return Ok(CreateTicketResponse::BadRequest(Json(
                "target_name is required".into(),
            )));
        }
        if let Some(exp) = body.expiry
            && exp <= Utc::now()
        {
            return Ok(CreateTicketResponse::BadRequest(Json(
                "expiry must be in the future".into(),
            )));
        }
        if let Some(uses) = body.number_of_uses
            && uses <= 0
        {
            return Ok(CreateTicketResponse::BadRequest(Json(
                "number_of_uses must be positive".into(),
            )));
        }

        let username = {
            let db = services.db_required().await?;
            let Some(user_model) = get_user(&auth, &db).await? else {
                return Ok(CreateTicketResponse::Unauthorized);
            };
            user_model.username
        };

        let allowed = {
            let mut config_provider = services.config_provider.lock().await;
            config_provider
                .authorize_target(&username, body.target_name.trim())
                .await?
        };
        if !allowed {
            return Ok(CreateTicketResponse::Forbidden(Json(
                "not authorized for this target".into(),
            )));
        }

        let db = services.db_required().await?;
        let secret = generate_ticket_secret();
        let object = Ticket::ActiveModel {
            id: Set(Uuid::new_v4()),
            secret: Set(secret.expose_secret().to_string()),
            username: Set(username),
            target: Set(body.target_name.trim().to_string()),
            uses_left: Set(body.number_of_uses),
            expiry: Set(body.expiry),
            created: Set(Utc::now()),
            description: Set(body.description.clone().unwrap_or_default()),
        }
        .insert(&db)
        .await
        .map_err(GatedError::from)?;

        Ok(CreateTicketResponse::Created(Json(
            ProfileTicketAndSecret {
                ticket: object.into(),
                secret: secret.expose_secret().to_string(),
            },
        )))
    }

    #[oai(
        path = "/profile/tickets/:id",
        method = "delete",
        operation_id = "delete_my_ticket",
        transform = "endpoint_auth"
    )]
    async fn api_delete_ticket(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        id: Path<Uuid>,
    ) -> Result<DeleteTicketResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(DeleteTicketResponse::Unauthorized);
        };

        let Some(model) = Ticket::Entity::find_by_id(id.0)
            .filter(Ticket::Column::Username.eq(user_model.username))
            .one(&db)
            .await?
        else {
            return Ok(DeleteTicketResponse::NotFound);
        };

        sea_orm::ModelTrait::delete(model, &db).await?;
        Ok(DeleteTicketResponse::Deleted)
    }
}
