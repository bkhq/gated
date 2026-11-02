use axum::extract::Path;
use gated_common::web::{Data, Json};
use gated_common::{GatedError, UserSsoCredential};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::SsoCredential;
use sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct ExistingSsoCredential {
    id: Uuid,
    provider: Option<String>,
    email: String,
}

#[derive(Deserialize, ToSchema)]
struct NewSsoCredential {
    provider: Option<String>,
    email: String,
}

impl From<SsoCredential::Model> for ExistingSsoCredential {
    fn from(credential: SsoCredential::Model) -> Self {
        Self {
            id: credential.id,
            email: credential.email,
            provider: credential.provider,
        }
    }
}

impl From<&NewSsoCredential> for UserSsoCredential {
    fn from(credential: &NewSsoCredential) -> Self {
        Self {
            email: credential.email.clone(),
            provider: credential.provider.clone(),
            // Manually-provisioned credentials carry no OIDC identity; they
            // are not usable for stable (iss, sub) OIDC login resolution.
            iss: None,
            sub: None,
        }
    }
}

api_response! {
    enum GetSsoCredentialsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingSsoCredential>>),
    }
}

api_response! {
    enum CreateSsoCredentialResponse {
        #[oai(status = 201)]
        Created(Json<ExistingSsoCredential>),
    }
}

api_response! {
    enum UpdateSsoCredentialResponse {
        #[oai(status = 200)]
        Updated(Json<ExistingSsoCredential>),
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    get,
    path = "/users/{user_id}/credentials/sso",
    operation_id = "get_sso_credentials"
)]
async fn api_get_all(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSsoCredentialsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let objects = SsoCredential::Entity::find()
        .filter(SsoCredential::Column::UserId.eq(*user_id))
        .all(&db)
        .await?;

    Ok(GetSsoCredentialsResponse::Ok(Json(
        objects.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(
    post,
    path = "/users/{user_id}/credentials/sso",
    operation_id = "create_sso_credential"
)]
async fn api_create(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewSsoCredential>,
) -> Result<CreateSsoCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let object = SsoCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(*user_id),
        ..SsoCredential::ActiveModel::from(UserSsoCredential::from(&*body))
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    Ok(CreateSsoCredentialResponse::Created(Json(object.into())))
}

api_response! {
    enum DeleteCredentialResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    put,
    path = "/users/{user_id}/credentials/sso/{id}",
    operation_id = "update_sso_credential"
)]
async fn api_update(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewSsoCredential>,
) -> Result<UpdateSsoCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let model = SsoCredential::ActiveModel {
        id: Set(id),
        user_id: Set(user_id),
        ..<_>::from(UserSsoCredential::from(&*body))
    }
    .update(&db)
    .await;

    match model {
        Ok(model) => Ok(UpdateSsoCredentialResponse::Updated(Json(model.into()))),
        Err(DbErr::RecordNotFound(_)) => Ok(UpdateSsoCredentialResponse::NotFound),
        Err(e) => Err(e.into()),
    }
}

#[utoipa::path(
    delete,
    path = "/users/{user_id}/credentials/sso/{id}",
    operation_id = "delete_sso_credential"
)]
async fn api_delete(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(role) = SsoCredential::Entity::find_by_id(id)
        .filter(SsoCredential::Column::UserId.eq(user_id))
        .one(&db)
        .await?
    else {
        return Ok(DeleteCredentialResponse::NotFound);
    };

    role.delete(&db).await?;
    Ok(DeleteCredentialResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all, api_create, api_update, api_delete,)
}
