use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::helpers::hash::generate_ticket_secret;
use gated_core::SharedDatabaseConnection;
use gated_db_entities::ApiToken;
use poem::web::Data;
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, Set,
};
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Object)]
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

#[derive(Object)]
struct NewApiToken {
    label: String,
    expiry: DateTime<Utc>,
}

#[derive(Object)]
struct TokenAndSecret {
    token: ExistingApiToken,
    secret: String,
}

#[derive(ApiResponse)]
enum GetApiTokensResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<ExistingApiToken>>),
}

#[derive(ApiResponse)]
enum CreateApiTokenResponse {
    #[oai(status = 201)]
    Created(Json<TokenAndSecret>),
    #[oai(status = 400)]
    BadRequest(Json<String>),
}

#[derive(ApiResponse)]
enum DeleteApiTokenResponse {
    #[oai(status = 204)]
    Deleted,
    #[oai(status = 404)]
    NotFound,
}

pub struct ListApi;

#[OpenApi]
impl ListApi {
    #[oai(
        path = "/users/:user_id/api-tokens",
        method = "get",
        operation_id = "get_user_api_tokens"
    )]
    async fn api_get_all(
        &self,
        db: Data<&SharedDatabaseConnection>,
        user_id: Path<Uuid>,
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

    #[oai(
        path = "/users/:user_id/api-tokens",
        method = "post",
        operation_id = "create_user_api_token"
    )]
    async fn api_create(
        &self,
        db: Data<&SharedDatabaseConnection>,
        user_id: Path<Uuid>,
        body: Json<NewApiToken>,
        _sec_scheme: AnySecurityScheme,
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
}

pub struct DetailApi;

#[OpenApi]
impl DetailApi {
    #[oai(
        path = "/users/:user_id/api-tokens/:id",
        method = "delete",
        operation_id = "delete_user_api_token"
    )]
    async fn api_delete(
        &self,
        db: Data<&SharedDatabaseConnection>,
        user_id: Path<Uuid>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<DeleteApiTokenResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let Some(model) = ApiToken::Entity::find_by_id(id.0)
            .filter(ApiToken::Column::UserId.eq(*user_id))
            .one(&db)
            .await?
        else {
            return Ok(DeleteApiTokenResponse::NotFound);
        };

        model.delete(&db).await?;
        Ok(DeleteApiTokenResponse::Deleted)
    }
}
