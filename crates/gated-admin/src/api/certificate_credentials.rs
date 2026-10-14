use axum::extract::Path;
use chrono::{DateTime, Utc};
use gated_ca::{deserialize_certificate, serialize_certificate_serial};
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::{CertificateCredential, CertificateRevocation, Parameters, User};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter, Set,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

fn certificate_fingerprint(certificate_pem: &str) -> Result<String, GatedError> {
    Ok(gated_ca::certificate_sha256_hex_fingerprint(
        &gated_ca::deserialize_certificate(certificate_pem)?,
    )?)
}

#[derive(Serialize, ToSchema)]
struct ExistingCertificateCredential {
    id: Uuid,
    label: String,
    date_added: Option<DateTime<Utc>>,
    last_used: Option<DateTime<Utc>>,
    fingerprint: String,
}

#[derive(Serialize, ToSchema)]
struct IssuedCertificateCredential {
    credential: ExistingCertificateCredential,
    certificate_pem: String,
}

#[derive(Deserialize, ToSchema)]
struct IssueCertificateCredentialRequest {
    label: String,
    public_key_pem: String,
}

#[derive(Deserialize, ToSchema)]
struct UpdateCertificateCredential {
    label: String,
}

impl From<CertificateCredential::Model> for ExistingCertificateCredential {
    fn from(credential: CertificateCredential::Model) -> Self {
        Self {
            id: credential.id,
            date_added: credential.date_added,
            last_used: credential.last_used,
            label: credential.label,
            fingerprint: certificate_fingerprint(&credential.certificate_pem)
                .unwrap_or_else(|_| "Invalid certificate".into()),
        }
    }
}

api_response! {
    enum GetCertificateCredentialsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ExistingCertificateCredential>>),
    }
}

api_response! {
    enum IssueCertificateCredentialResponse {
        #[oai(status = 201)]
        Issued(Json<IssuedCertificateCredential>),
    }
}

api_response! {
    enum UpdateCertificateCredentialResponse {
        #[oai(status = 200)]
        Updated(Json<ExistingCertificateCredential>),
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    get,
    path = "/users/{user_id}/credentials/certificates",
    operation_id = "get_certificate_credentials"
)]
async fn api_get_all(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _auth: AnySecurityScheme,
) -> Result<GetCertificateCredentialsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let objects = CertificateCredential::Entity::find()
        .filter(CertificateCredential::Column::UserId.eq(*user_id))
        .all(&db)
        .await?;

    Ok(GetCertificateCredentialsResponse::Ok(Json(
        objects.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(
    post,
    path = "/users/{user_id}/credentials/certificates",
    operation_id = "issue_certificate_credential"
)]
async fn api_issue(
    user_id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _auth: AnySecurityScheme,
    body: Json<IssueCertificateCredentialRequest>,
) -> Result<IssueCertificateCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let params = Parameters::Entity::get(&db).await?;
    let ca = gated_ca::deserialize_ca(&params.ca_certificate_pem, &params.ca_private_key_pem)?;
    let user = User::Entity::find_by_id(*user_id)
        .one(&db)
        .await?
        .ok_or(GatedError::UserNotFound(user_id.to_string()))?;

    let public_key_pem = body.public_key_pem.trim();
    let client_cert =
        gated_ca::issue_client_certificate(&ca, &user.username, public_key_pem, *user_id)?;

    let client_cert_pem = gated_ca::certificate_to_pem(&client_cert)?;

    let object = CertificateCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(*user_id),
        date_added: Set(Some(Utc::now())),
        last_used: Set(None),
        label: Set(body.label.clone()),
        certificate_pem: Set(client_cert_pem.clone()),
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    Ok(IssueCertificateCredentialResponse::Issued(Json(
        IssuedCertificateCredential {
            credential: object.into(),
            certificate_pem: client_cert_pem,
        },
    )))
}

api_response! {
    enum RevokeCertificateCredentialResponse {
        #[oai(status = 204)]
        Revoked,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    patch,
    path = "/users/{user_id}/credentials/certificates/{id}",
    operation_id = "update_certificate_credential"
)]
async fn api_update(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _auth: AnySecurityScheme,
    body: Json<UpdateCertificateCredential>,
) -> Result<UpdateCertificateCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let Some(cred) = CertificateCredential::Entity::find_by_id(id)
        .filter(CertificateCredential::Column::UserId.eq(user_id))
        .one(&db)
        .await?
    else {
        return Ok(UpdateCertificateCredentialResponse::NotFound);
    };

    let mut am = cred.into_active_model();

    am.label = Set(body.label.clone());
    let model = am.update(&db).await?;

    Ok(UpdateCertificateCredentialResponse::Updated(Json(
        model.into(),
    )))
}

#[utoipa::path(
    delete,
    path = "/users/{user_id}/credentials/certificates/{id}",
    operation_id = "revoke_certificate_credential"
)]
async fn api_delete(
    Path((user_id, id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _auth: AnySecurityScheme,
) -> Result<RevokeCertificateCredentialResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(model) = CertificateCredential::Entity::find_by_id(id)
        .filter(CertificateCredential::Column::UserId.eq(user_id))
        .one(&db)
        .await?
    else {
        return Ok(RevokeCertificateCredentialResponse::NotFound);
    };

    let cert = deserialize_certificate(&model.certificate_pem)?;

    CertificateRevocation::ActiveModel {
        id: Set(Uuid::new_v4()),
        date_added: Set(Utc::now()),
        serial_number_base64: Set(serialize_certificate_serial(&cert)),
    }
    .insert(&db)
    .await?;

    model.delete(&db).await?;
    Ok(RevokeCertificateCredentialResponse::Revoked)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all, api_issue, api_update, api_delete,)
}
