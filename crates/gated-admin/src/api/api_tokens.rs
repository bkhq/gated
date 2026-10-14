use axum::extract::Path;
use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::helpers::hash::generate_ticket_secret;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::ApiToken;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, Set,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct ExistingApiToken {
    id: Uuid,
    user_id: Uuid,
    label: String,
    created: DateTime<Utc>,
    expiry: DateTime<Utc>,
}

impl From<ApiToken::Model> for ExistingApiToken {
    fn from(token: ApiToken::Model) -> Self {
        Self {
            id: token.id,
            user_id: token.user_id,
            label: token.label,
            created: token.created,
            expiry: token.expiry,
        }
    }
}

#[derive(Deserialize, ToSchema)]
struct NewApiToken {
    label: String,
    expiry: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
struct TokenAndSecret {
    token: ExistingApiToken,
    secret: String,
}

api_response! {
    enum GetApiTokensResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingApiToken>>),
    }
}

api_response! {
    enum CreateApiTokenResponse {
        #[oai(status = 201)]
        Created(Json<TokenAndSecret>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

api_response! {
    enum DeleteApiTokenResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    get,
    path = "/users/{user_id}/api-tokens",
    operation_id = "get_user_api_tokens"
)]
async fn api_get_all(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetApiTokensResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let objects = ApiToken::Entity::find()
        .filter(ApiToken::Column::UserId.eq(*user_id))
        .order_by_desc(ApiToken::Column::Created)
        .all(&db)
        .await?;

    Ok(GetApiTokensResponse::Ok(Json(
        objects.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(
    post,
    path = "/users/{user_id}/api-tokens",
    operation_id = "create_user_api_token"
)]
async fn api_create(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewApiToken>,
) -> Result<CreateApiTokenResponse, GatedError> {
    if body.expiry <= Utc::now() {
        return Ok(CreateApiTokenResponse::BadRequest(Json(
            "expiry must be in the future".into(),
        )));
    }
    if body.label.trim().is_empty() {
        return Ok(CreateApiTokenResponse::BadRequest(Json(
            "label is required".into(),
        )));
    }

    let db = gated_core::db_required(&db).await?;

    let secret = generate_ticket_secret();
    let object = ApiToken::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(*user_id),
        created: Set(Utc::now()),
        expiry: Set(body.expiry),
        label: Set(body.label.trim().to_string()),
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
    path = "/users/{user_id}/api-tokens/{id}",
    operation_id = "delete_user_api_token"
)]
async fn api_delete(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteApiTokenResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(model) = ApiToken::Entity::find_by_id(id)
        .filter(ApiToken::Column::UserId.eq(user_id))
        .one(&db)
        .await?
    else {
        return Ok(DeleteApiTokenResponse::NotFound);
    };

    model.delete(&db).await?;
    Ok(DeleteApiTokenResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all, api_create, api_delete,)
}
