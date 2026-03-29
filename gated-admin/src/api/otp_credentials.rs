use std::sync::Arc;

use poem::web::Data;
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, ModelTrait, PaginatorTrait,
    QueryFilter, Set,
};
use tokio::sync::Mutex;
use uuid::Uuid;
use gated_common::{UserRequireCredentialsPolicy, UserTotpCredential, GatedError};
use gated_db_entities::{OtpCredential, User};

use super::AnySecurityScheme;

#[derive(Object)]
struct ExistingOtpCredential {
    id: Uuid,
}

#[derive(Object)]
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

#[derive(ApiResponse)]
enum GetOtpCredentialsResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<ExistingOtpCredential>>),
}

#[derive(ApiResponse)]
enum CreateOtpCredentialResponse {
    #[oai(status = 201)]
    Created(Json<ExistingOtpCredential>),
}

pub struct ListApi;

#[OpenApi]
impl ListApi {
    #[oai(
        path = "/users/:user_id/credentials/otp",
        method = "get",
        operation_id = "get_otp_credentials"
    )]
    async fn api_get_all(
        &self,
        db: Data<&Arc<Mutex<DatabaseConnection>>>,
        user_id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetOtpCredentialsResponse, GatedError> {
        let db = db.lock().await;

        let objects = OtpCredential::Entity::find()
            .filter(OtpCredential::Column::UserId.eq(*user_id))
            .all(&*db)
            .await?;

        Ok(GetOtpCredentialsResponse::Ok(Json(
            objects.into_iter().map(Into::into).collect(),
        )))
    }

    #[oai(
        path = "/users/:user_id/credentials/otp",
        method = "post",
        operation_id = "create_otp_credential"
    )]
    async fn api_create(
        &self,
        db: Data<&Arc<Mutex<DatabaseConnection>>>,
        body: Json<NewOtpCredential>,
        user_id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<CreateOtpCredentialResponse, GatedError> {
        let db = db.lock().await;

        let object = OtpCredential::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(*user_id),
            ..OtpCredential::ActiveModel::from(UserTotpCredential::from(&*body))
        }
        .insert(&*db)
        .await
        .map_err(GatedError::from)?;

        Ok(CreateOtpCredentialResponse::Created(Json(object.into())))
    }
}

#[derive(ApiResponse)]
enum DeleteCredentialResponse {
    #[oai(status = 204)]
    Deleted,
    #[oai(status = 404)]
    NotFound,
}

pub struct DetailApi;

#[OpenApi]
impl DetailApi {
    #[oai(
        path = "/users/:user_id/credentials/otp/:id",
        method = "delete",
        operation_id = "delete_otp_credential"
    )]
    async fn api_delete(
        &self,
        db: Data<&Arc<Mutex<DatabaseConnection>>>,
        user_id: Path<Uuid>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<DeleteCredentialResponse, GatedError> {
        let db = db.lock().await;

        let Some(cred) = OtpCredential::Entity::find_by_id(id.0)
            .filter(OtpCredential::Column::UserId.eq(*user_id))
            .one(&*db)
            .await?
        else {
            return Ok(DeleteCredentialResponse::NotFound);
        };

        cred.delete(&*db).await?;

        // If no OTP credentials remain, remove OTP from the user's credential policy
        let remaining = OtpCredential::Entity::find()
            .filter(OtpCredential::Column::UserId.eq(*user_id))
            .count(&*db)
            .await?;

        if remaining == 0 {
            if let Some(user) = User::Entity::find_by_id(*user_id).one(&*db).await? {
                let policy: Option<UserRequireCredentialsPolicy> =
                    serde_json::from_value(user.credential_policy.clone()).ok().flatten();
                if let Some(policy) = policy {
                    let new_policy = policy.downgrade_from_otp();
                    let mut active: User::ActiveModel = user.into();
                    active.credential_policy =
                        Set(serde_json::to_value(&new_policy).unwrap_or_default());
                    active.update(&*db).await?;
                }
            }
        }

        Ok(DeleteCredentialResponse::Deleted)
    }
}
