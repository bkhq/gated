use axum::extract::Path;
use chrono::{DateTime, Utc};
use gated_common::web::{Data, Json};
use gated_common::{GatedError, UserPublicKeyCredential};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::PublicKeyCredential;
use sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter, Set};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct ExistingPublicKeyCredential {
    id: Uuid,
    label: String,
    date_added: Option<DateTime<Utc>>,
    last_used: Option<DateTime<Utc>>,
    openssh_public_key: String,
}

#[derive(Deserialize, ToSchema)]
struct NewPublicKeyCredential {
    label: String,
    openssh_public_key: String,
}

impl From<PublicKeyCredential::Model> for ExistingPublicKeyCredential {
    fn from(credential: PublicKeyCredential::Model) -> Self {
        Self {
            id: credential.id,
            date_added: credential.date_added,
            last_used: credential.last_used,
            label: credential.label,
            openssh_public_key: credential.openssh_public_key,
        }
    }
}

impl TryFrom<&NewPublicKeyCredential> for UserPublicKeyCredential {
    type Error = GatedError;

    fn try_from(credential: &NewPublicKeyCredential) -> Result<Self, GatedError> {
        let mut key = russh::keys::PublicKey::from_openssh(&credential.openssh_public_key)
            .map_err(russh::keys::Error::from)?;

        key.set_comment("");

        Ok(Self {
            key: key.to_openssh().map_err(russh::keys::Error::from)?.into(),
        })
    }
}

api_response! {
    enum GetPublicKeyCredentialsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingPublicKeyCredential>>),
    }
}

api_response! {
    enum CreatePublicKeyCredentialResponse {
        #[oai(status = 201)]
        Created(Json<ExistingPublicKeyCredential>),
    }
}

api_response! {
    enum UpdatePublicKeyCredentialResponse {
        #[oai(status = 200)]
        Updated(Json<ExistingPublicKeyCredential>),
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    get,
    path = "/users/{user_id}/credentials/public-keys",
    operation_id = "get_public_key_credentials"
)]
async fn api_get_all(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetPublicKeyCredentialsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let objects = PublicKeyCredential::Entity::find()
        .filter(PublicKeyCredential::Column::UserId.eq(*user_id))
        .all(&db)
        .await?;

    Ok(GetPublicKeyCredentialsResponse::Ok(Json(
        objects.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(
    post,
    path = "/users/{user_id}/credentials/public-keys",
    operation_id = "create_public_key_credential"
)]
async fn api_create(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewPublicKeyCredential>,
) -> Result<CreatePublicKeyCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let object = PublicKeyCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(*user_id),
        date_added: Set(Some(Utc::now())),
        last_used: Set(None),
        label: Set(body.label.clone()),
        ..PublicKeyCredential::ActiveModel::from(UserPublicKeyCredential::try_from(&*body)?)
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    Ok(CreatePublicKeyCredentialResponse::Created(Json(
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
    put,
    path = "/users/{user_id}/credentials/public-keys/{id}",
    operation_id = "update_public_key_credential"
)]
async fn api_update(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewPublicKeyCredential>,
) -> Result<UpdatePublicKeyCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let model = PublicKeyCredential::ActiveModel {
        id: Set(id),
        user_id: Set(user_id),
        date_added: Set(Some(Utc::now())),
        label: Set(body.label.clone()),
        ..<_>::from(UserPublicKeyCredential::try_from(&*body)?)
    }
    .update(&db)
    .await;

    match model {
        Ok(model) => Ok(UpdatePublicKeyCredentialResponse::Updated(Json(
            model.into(),
        ))),
        Err(DbErr::RecordNotFound(_)) => Ok(UpdatePublicKeyCredentialResponse::NotFound),
        Err(e) => Err(e.into()),
    }
}

#[utoipa::path(
    delete,
    path = "/users/{user_id}/credentials/public-keys/{id}",
    operation_id = "delete_public_key_credential"
)]
async fn api_delete(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(model) = PublicKeyCredential::Entity::find_by_id(id)
        .filter(PublicKeyCredential::Column::UserId.eq(user_id))
        .one(&db)
        .await?
    else {
        return Ok(DeleteCredentialResponse::NotFound);
    };

    model.delete(&db).await?;
    Ok(DeleteCredentialResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all, api_create, api_update, api_delete,)
}
