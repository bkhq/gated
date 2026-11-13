use axum::extract::Path;
use axum::http::request::Parts;
use axum::middleware::from_fn;
use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::Secret;
use gated_common::helpers::hash::generate_ticket_secret;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::{ConfigProvider, Services, authorize_ticket, consume_ticket};
use gated_db_entities::Target::{self, TargetKind};
use gated_db_entities::{Session as SessionRow, Ticket};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::auth::{LOGIN_RATE_LIMITER, login_rate_limit_key, rate_limit_allows};
use super::common::{get_user, is_ticket_auth};
use crate::http_service::common::{
    RequestAuthorization, authorize_ticket_session, forbid_ticket_sessions, require_auth,
};
use crate::http_service::session::{Session, SessionStore};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Deserialize, ToSchema)]
struct NewProfileTicket {
    target_name: String,
    expiry: Option<DateTime<Utc>>,
    number_of_uses: Option<i16>,
    description: Option<String>,
}

#[derive(Serialize, ToSchema)]
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

#[derive(Serialize, ToSchema)]
struct ProfileTicketAndSecret {
    ticket: ExistingProfileTicket,
    secret: String,
}

api_response! {
    enum GetTicketsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingProfileTicket>>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
    }
}

api_response! {
    enum CreateTicketResponse {
        #[oai(status = 201)]
        Created(Json<ProfileTicketAndSecret>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 403)]
        Forbidden(Json<String>),
    }
}

api_response! {
    enum DeleteTicketResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(get, path = "/profile/tickets", operation_id = "get_my_tickets")]
async fn api_get_tickets(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
) -> Result<GetTicketsResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(GetTicketsResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
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

#[utoipa::path(post, path = "/profile/tickets", operation_id = "create_my_ticket")]
async fn api_create_ticket(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
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
            return Ok(CreateTicketResponse::Unauthorized(Json(
                "not signed in".into(),
            )));
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

#[utoipa::path(
    delete,
    path = "/profile/tickets/{id}",
    operation_id = "delete_my_ticket"
)]
async fn api_delete_ticket(
    id: Path<Uuid>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
) -> Result<DeleteTicketResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(DeleteTicketResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
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

api_response! {
    enum RotateTicketResponse {
        #[oai(status = 200)]
        Rotated(Json<ProfileTicketAndSecret>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 404)]
        NotFound,
    }
}

/// Replaces the secret of a ticket and ends the sessions opened with the old
/// one. Returns the new secret.
pub(crate) async fn rotate_ticket(
    services: &Services,
    store: &Mutex<SessionStore>,
    ticket: Ticket::Model,
) -> Result<(Ticket::Model, Secret<String>), GatedError> {
    let db = services.db_required().await?;
    let secret = generate_ticket_secret();
    let ticket_id = ticket.id;
    let mut model: Ticket::ActiveModel = ticket.into();
    model.secret = Set(gated_common::hash_secret(secret.expose_secret()));
    let ticket = model.update(&db).await?;

    let open: Vec<Uuid> = SessionRow::Entity::find()
        .filter(SessionRow::Column::TicketId.eq(ticket_id))
        .filter(SessionRow::Column::Ended.is_null())
        .all(&db)
        .await?
        .into_iter()
        .map(|session| session.id)
        .collect();
    drop(db);
    let mut ended = store.lock().await.revoke_ticket_sessions(ticket_id).await;
    {
        let state = services.state.read().await;
        for id in open {
            if let Some(session) = state.sessions.get(&id) {
                session.lock().await.handle.close();
                ended += 1;
            }
        }
    }
    info!(target: "audit", %ticket_id, ended, "Ticket secret rotated");
    Ok((ticket, secret))
}

#[utoipa::path(
    post,
    path = "/profile/tickets/{id}/rotate",
    operation_id = "rotate_my_ticket"
)]
async fn api_rotate_ticket(
    id: Path<Uuid>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    store: Data<Arc<Mutex<SessionStore>>>,
) -> Result<RotateTicketResponse, GatedError> {
    let db = services.db_required().await?;
    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(RotateTicketResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };
    let Some(ticket) = Ticket::Entity::find_by_id(id.0)
        .filter(Ticket::Column::Username.eq(user_model.username))
        .one(&db)
        .await?
    else {
        return Ok(RotateTicketResponse::NotFound);
    };
    drop(db);
    let (ticket, secret) = rotate_ticket(&services, &store, ticket).await?;
    Ok(RotateTicketResponse::Rotated(Json(
        ProfileTicketAndSecret {
            ticket: ticket.into(),
            secret: secret.expose_secret().to_string(),
        },
    )))
}

#[derive(Deserialize, ToSchema)]
struct ClaimTicketRequest {
    secret: String,
}

#[derive(Serialize, ToSchema)]
struct ClaimedTicket {
    target_name: String,
    kind: TargetKind,
}

api_response! {
    enum ClaimTicketResponse {
        #[oai(status = 200)]
        Ok(Json<ClaimedTicket>),
        /// Unknown, expired or used-up ticket, or its target is gone.
        #[oai(status = 404)]
        NotFound(Json<String>),
        /// Too many claims from this address.
        #[oai(status = 429)]
        TooManyRequests,
    }
}

/// Signs the browser session in with a ticket. The recipient's link keeps
/// the secret in the URL fragment and posts it here, so nothing but this
/// call consumes a use; `?gated-ticket=` consumed one on any GET, including a
/// chat app's link preview.
#[utoipa::path(post, path = "/tickets/claim", operation_id = "claim_ticket")]
async fn api_claim_ticket(
    req: Parts,
    session: Session,
    services: Data<Services>,
    body: Json<ClaimTicketRequest>,
) -> Result<ClaimTicketResponse, GatedError> {
    let rate_key = login_rate_limit_key(&req, &services, "ticket").await;
    if !rate_limit_allows(&LOGIN_RATE_LIMITER, &rate_key) {
        warn!(target: "audit", protocol = "http", "ticket_claim_rate_limited");
        return Ok(ClaimTicketResponse::TooManyRequests);
    }

    let secret = Secret::new(body.secret.clone());
    let Some((ticket, user_info)) = authorize_ticket(
        &services.db,
        &secret,
        gated_core::logging::http::client_ip_addr(&req.headers, &req.extensions, &services).await,
    )
    .await?
    else {
        warn!(target: "audit", protocol = "http", "ticket_claim_rejected");
        return Ok(ClaimTicketResponse::NotFound(Json(
            "ticket not found, expired or used up".into(),
        )));
    };
    let db = services.db_required().await?;
    let Some(target) = Target::Entity::find()
        .filter(Target::Column::Name.eq(&ticket.target))
        .one(&db)
        .await?
    else {
        return Ok(ClaimTicketResponse::NotFound(Json(
            "the ticket's target no longer exists".into(),
        )));
    };

    consume_ticket(&services.db, &ticket.id).await?;
    let store = req
        .extensions
        .get::<Arc<Mutex<SessionStore>>>()
        .ok_or_else(|| GatedError::Other(anyhow::anyhow!("SessionStore not in request").into()))?;
    authorize_ticket_session(store, &session, &ticket, user_info).await?;
    info!(target: "audit",
        username = %ticket.username,
        ticket_id = %ticket.id,
        target = %ticket.target,
        protocol = "http",
        "ticket_claimed"
    );

    Ok(ClaimTicketResponse::Ok(Json(ClaimedTicket {
        target_name: ticket.target,
        kind: target.kind,
    })))
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_tickets,
        api_create_ticket,
        api_delete_ticket,
        api_rotate_ticket,
    )
    .route_layer(from_fn(forbid_ticket_sessions))
    .route_layer(from_fn(require_auth))
    .merge(api_routes!(api_claim_ticket,))
}
