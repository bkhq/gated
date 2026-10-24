use axum::extract::Path;
use gated_common::web::{Data, Json};
use gated_common::{GatedError, Secret, UserPasswordCredential};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::PasswordCredential;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct ExistingPasswordCredential {
    id: Uuid,
}

#[derive(Deserialize, ToSchema)]
struct NewPasswordCredential {
    #[schema(value_type = String)]
    password: Secret<String>,
}

impl From<PasswordCredential::Model> for ExistingPasswordCredential {
    fn from(credential: PasswordCredential::Model) -> Self {
        Self { id: credential.id }
    }
}

api_response! {
    enum GetPasswordCredentialsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingPasswordCredential>>),
    }
}

api_response! {
    enum CreatePasswordCredentialResponse {
        #[oai(status = 201)]
        Created(Json<ExistingPasswordCredential>),
    }
}

#[utoipa::path(
    get,
    path = "/users/{user_id}/credentials/passwords",
    operation_id = "get_password_credentials"
)]
async fn api_get_all(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetPasswordCredentialsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let objects = PasswordCredential::Entity::find()
        .filter(PasswordCredential::Column::UserId.eq(*user_id))
        .all(&db)
        .await?;

    Ok(GetPasswordCredentialsResponse::Ok(Json(
        objects.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(
    post,
    path = "/users/{user_id}/credentials/passwords",
    operation_id = "create_password_credential"
)]
async fn api_create(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewPasswordCredential>,
) -> Result<CreatePasswordCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let object = PasswordCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(*user_id),
        ..PasswordCredential::ActiveModel::from(UserPasswordCredential::from_password(
            &body.password,
        ))
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    Ok(CreatePasswordCredentialResponse::Created(Json(
        object.into(),
    )))
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
    delete,
    path = "/users/{user_id}/credentials/passwords/{id}",
    operation_id = "delete_password_credential"
)]
async fn api_delete(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(model) = PasswordCredential::Entity::find_by_id(id)
        .filter(PasswordCredential::Column::UserId.eq(user_id))
        .one(&db)
        .await?
    else {
        return Ok(DeleteCredentialResponse::NotFound);
    };

    model.delete(&db).await?;
    Ok(DeleteCredentialResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all, api_create, api_delete,)
}
