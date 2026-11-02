use axum::extract::Path;
use axum::middleware::from_fn;
use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::helpers::hash::generate_ticket_secret;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use gated_db_entities::ApiToken;
use sea_orm::{ActiveModelTrait, ColumnTrait, ModelTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::common::get_user;
use crate::http_service::common::{RequestAuthorization, require_auth};

api_response! {
    enum GetApiTokensResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingApiToken>>),
        #[oai(status = 401)]
        Unauthorized,
    }
}

#[derive(Deserialize, ToSchema)]
struct NewApiToken {
    label: String,
    expiry: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
struct ExistingApiToken {
    id: Uuid,
    label: String,
    created: DateTime<Utc>,
    expiry: DateTime<Utc>,
}

impl From<ApiToken::Model> for ExistingApiToken {
    fn from(token: ApiToken::Model) -> Self {
        Self {
            id: token.id,
            label: token.label,
            created: token.created,
            expiry: token.expiry,
        }
    }
}

#[derive(Serialize, ToSchema)]
struct TokenAndSecret {
    token: ExistingApiToken,
    secret: String,
}

api_response! {
    enum CreateApiTokenResponse {
        #[oai(status = 201)]
        Created(Json<TokenAndSecret>),
        #[oai(status = 401)]
        Unauthorized,
    }
}

api_response! {
    enum DeleteApiTokenResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 401)]
        Unauthorized,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(get, path = "/profile/api-tokens", operation_id = "get_my_api_tokens")]
async fn api_get_api_tokens(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
) -> Result<GetApiTokensResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(GetApiTokensResponse::Unauthorized);
    };

    let api_tokens = user_model.find_related(ApiToken::Entity).all(&db).await?;

    Ok(GetApiTokensResponse::Ok(Json(
        api_tokens.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(post, path = "/profile/api-tokens", operation_id = "create_api_token")]
async fn api_create_api_token(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    body: Json<NewApiToken>,
) -> Result<CreateApiTokenResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(CreateApiTokenResponse::Unauthorized);
    };

    let secret = generate_ticket_secret();
    let object = ApiToken::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(user_model.id),
        created: Set(Utc::now()),
        expiry: Set(body.expiry),
        label: Set(body.label.clone()),
        secret: Set(secret.expose_secret().to_string()),
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    Ok(CreateApiTokenResponse::Created(Json(TokenAndSecret {
        token: object.into(),
        secret: secret.expose_secret().to_string(),
    })))
}

#[utoipa::path(
    delete,
    path = "/profile/api-tokens/{id}",
    operation_id = "delete_my_api_token"
)]
async fn api_delete_api_token(
    id: Path<Uuid>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
) -> Result<DeleteApiTokenResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(DeleteApiTokenResponse::Unauthorized);
    };

    let Some(model) = user_model
        .find_related(ApiToken::Entity)
        .filter(ApiToken::Column::Id.eq(id.0))
        .one(&db)
        .await?
    else {
        return Ok(DeleteApiTokenResponse::NotFound);
    };

    model.delete(&db).await?;
    Ok(DeleteApiTokenResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_api_tokens,
        api_create_api_token,
        api_delete_api_token,
    )
    .route_layer(from_fn(require_auth))
}
