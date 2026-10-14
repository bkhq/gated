use axum::extract::Path;
use gated_common::web::{Data, Json};
use gated_common::{GatedError, UserRequireCredentialsPolicy, UserTotpCredential};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::{OtpCredential, User};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, PaginatorTrait, QueryFilter, Set,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct ExistingOtpCredential {
    id: Uuid,
}

#[derive(Deserialize, ToSchema)]
struct NewOtpCredential {
    secret_key: Vec<u8>,
}

impl From<OtpCredential::Model> for ExistingOtpCredential {
    fn from(credential: OtpCredential::Model) -> Self {
        Self { id: credential.id }
    }
}

impl From<&NewOtpCredential> for UserTotpCredential {
    fn from(credential: &NewOtpCredential) -> Self {
        Self {
            key: credential.secret_key.clone().into(),
        }
    }
}

api_response! {
    enum GetOtpCredentialsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingOtpCredential>>),
    }
}

api_response! {
    enum CreateOtpCredentialResponse {
        #[oai(status = 201)]
        Created(Json<ExistingOtpCredential>),
    }
}

#[utoipa::path(
    get,
    path = "/users/{user_id}/credentials/otp",
    operation_id = "get_otp_credentials"
)]
async fn api_get_all(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetOtpCredentialsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let objects = OtpCredential::Entity::find()
        .filter(OtpCredential::Column::UserId.eq(*user_id))
        .all(&db)
        .await?;

    Ok(GetOtpCredentialsResponse::Ok(Json(
        objects.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(
    post,
    path = "/users/{user_id}/credentials/otp",
    operation_id = "create_otp_credential"
)]
async fn api_create(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewOtpCredential>,
) -> Result<CreateOtpCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let object = OtpCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(*user_id),
        ..OtpCredential::ActiveModel::from(UserTotpCredential::from(&*body))
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    Ok(CreateOtpCredentialResponse::Created(Json(object.into())))
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
    path = "/users/{user_id}/credentials/otp/{id}",
    operation_id = "delete_otp_credential"
)]
async fn api_delete(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(cred) = OtpCredential::Entity::find_by_id(id)
        .filter(OtpCredential::Column::UserId.eq(user_id))
        .one(&db)
        .await?
    else {
        return Ok(DeleteCredentialResponse::NotFound);
    };

    cred.delete(&db).await?;

    // If no OTP credentials remain, remove OTP from the user's credential policy
    let remaining = OtpCredential::Entity::find()
        .filter(OtpCredential::Column::UserId.eq(user_id))
        .count(&db)
        .await?;

    if remaining == 0
        && let Some(user) = User::Entity::find_by_id(user_id).one(&db).await?
    {
        let policy: Option<UserRequireCredentialsPolicy> =
            serde_json::from_value(user.credential_policy.clone())
                .ok()
                .flatten();
        if let Some(policy) = policy {
            let new_policy = policy.downgrade_from_otp();
            let mut active: User::ActiveModel = user.into();
            active.credential_policy = Set(serde_json::to_value(&new_policy).unwrap_or_default());
            active.update(&db).await?;
        }
    }

    Ok(DeleteCredentialResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all, api_create, api_delete,)
}
