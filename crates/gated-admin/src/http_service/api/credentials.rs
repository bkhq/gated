use crate::http_service::session::Session;
use axum::extract::{Path, Request};
use axum::middleware::{Next, from_fn};
use axum::response::{IntoResponse, Response};
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use chrono::{DateTime, Utc};
use gated_common::auth::AuthCredential;
use gated_common::helpers::otp::{
    OtpSecretKey, TotpCheck, check_totp, generate_key, generate_setup_url,
};
use gated_common::{GatedError, Secret, User, UserPasswordCredential};
use gated_core::{ConfigProvider, Services};
use gated_db_entities::{
    self as entities, CertificateCredential, Parameters, PasswordCredential, PublicKeyCredential,
};
use http::{Method, StatusCode};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, PaginatorTrait, QueryFilter, Set,
};
use tokio::sync::Mutex;
use tracing::info;
use uuid::Uuid;

use super::common::{get_user, is_ticket_auth};
use crate::api::{RevealConfirmation, StepUpFailure, verify_step_up};
use crate::http_service::api::AnySecurityScheme;
use crate::http_service::common::{RequestAuthorization, forbid_ticket_sessions, require_auth};
use crate::http_service::session::{SessionStore, end_user_sessions};

/// How long a started OTP enrollment (a server-generated secret awaiting a
/// proof-of-possession code) is retained before it is pruned.
const OTP_ENROLLMENT_TTL: Duration = Duration::from_secs(600);

/// Server-generated TOTP secrets for in-progress self-service
/// enrollments, keyed by user id. The secret is held here only until the
/// user confirms it with a live code; the client never supplies the
/// secret. Pruned lazily on access.
static PENDING_OTP_ENROLLMENTS: LazyLock<StdMutex<HashMap<Uuid, (OtpSecretKey, Instant)>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn prune_pending_enrollments(map: &mut HashMap<Uuid, (OtpSecretKey, Instant)>) {
    let now = Instant::now();
    map.retain(|_, (_, started)| now.duration_since(*started) < OTP_ENROLLMENT_TTL);
}

#[derive(Serialize, ToSchema)]
enum PasswordState {
    Unset,
    Set,
    MultipleSet,
}

#[derive(Serialize, ToSchema)]
struct ExistingSsoCredential {
    id: Uuid,
    provider: Option<String>,
    email: String,
}

impl From<entities::SsoCredential::Model> for ExistingSsoCredential {
    fn from(credential: entities::SsoCredential::Model) -> Self {
        Self {
            id: credential.id,
            provider: credential.provider,
            email: credential.email,
        }
    }
}

#[derive(Deserialize, ToSchema)]
struct ChangePasswordRequest {
    /// The caller's current password, re-verified before the
    /// change is applied (a session alone must not be enough).
    old_password: String,
    password: String,
}

api_response! {
    enum ChangePasswordResponse {
        #[oai(status = 201)]
        Done(Json<PasswordState>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 403)]
        Forbidden(Json<String>),
    }
}

#[derive(Serialize, ToSchema)]
pub struct CredentialsState {
    password: PasswordState,
    otp: Vec<ExistingOtpCredential>,
    public_keys: Vec<ExistingPublicKeyCredential>,
    certificates: Vec<ExistingCertificateCredential>,
    sso: Vec<ExistingSsoCredential>,
    credential_policy: gated_common::api::types::UserRequireCredentialsPolicy,
    /// Rules a new password must satisfy.
    password_policy: gated_common::helpers::password_policy::PasswordPolicy,
}

api_response! {
    #[allow(clippy::large_enum_variant)]
    enum CredentialsStateResponse {
        #[oai(status = 200)]
        Ok(Json<CredentialsState>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
    }
}

#[derive(Deserialize, ToSchema)]
struct NewPublicKeyCredential {
    label: String,
    openssh_public_key: String,
    /// Browser sessions confirm with the password when no OTP is enrolled.
    password: Option<String>,
    /// Browser sessions confirm with an OTP when one is enrolled.
    otp: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct ExistingPublicKeyCredential {
    id: Uuid,
    label: String,
    date_added: Option<DateTime<Utc>>,
    last_used: Option<DateTime<Utc>>,
    openssh_public_key: String,
    /// SHA256 fingerprint; empty when the stored key does not parse.
    fingerprint: String,
}

impl From<entities::PublicKeyCredential::Model> for ExistingPublicKeyCredential {
    fn from(credential: entities::PublicKeyCredential::Model) -> Self {
        Self {
            id: credential.id,
            label: credential.label,
            date_added: credential.date_added,
            last_used: credential.last_used,
            fingerprint: russh::keys::PublicKey::from_openssh(&credential.openssh_public_key)
                .map(|key| key.fingerprint(russh::keys::HashAlg::Sha256).to_string())
                .unwrap_or_default(),
            openssh_public_key: credential.openssh_public_key,
        }
    }
}
api_response! {
    enum CreatePublicKeyCredentialResponse {
        #[oai(status = 201)]
        Created(Json<ExistingPublicKeyCredential>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 403)]
        Forbidden(Json<String>),
        #[oai(status = 429)]
        RateLimited,
    }
}

/// The key as `<type> <base64>`, which is what SSH authentication compares
/// against; the comment is dropped like the admin endpoint does.
fn normalize_public_key(pasted: &str) -> Result<String, russh::keys::Error> {
    let mut key = russh::keys::PublicKey::from_openssh(pasted)?;
    key.set_comment("");
    Ok(key.to_openssh()?)
}

api_response! {
    enum DeleteCredentialResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 403)]
        Forbidden(Json<String>),
        #[oai(status = 404)]
        NotFound,
    }
}

/// The secret is generated server-side; enrollment is confirmed
/// by sending a live code from the authenticator, proving possession.
#[derive(Deserialize, ToSchema)]
struct ConfirmOtpCredential {
    otp: String,
}

/// Response of starting an OTP enrollment: an `otpauth://` provisioning URI
/// for the server-generated secret. The raw secret is never returned.
#[derive(Serialize, ToSchema)]
struct BeginOtpEnrollment {
    provisioning_uri: String,
}

api_response! {
    enum BeginOtpEnrollmentResponse {
        #[oai(status = 201)]
        Created(Json<BeginOtpEnrollment>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 403)]
        Forbidden(Json<String>),
    }
}

#[derive(Serialize, ToSchema)]
struct ExistingOtpCredential {
    id: Uuid,
}

impl From<entities::OtpCredential::Model> for ExistingOtpCredential {
    fn from(credential: entities::OtpCredential::Model) -> Self {
        Self { id: credential.id }
    }
}

api_response! {
    enum CreateOtpCredentialResponse {
        #[oai(status = 201)]
        Created(Json<ExistingOtpCredential>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 403)]
        Forbidden(Json<String>),
    }
}

#[derive(Serialize, ToSchema)]
struct ExistingCertificateCredential {
    id: Uuid,
    label: String,
    date_added: Option<DateTime<Utc>>,
    last_used: Option<DateTime<Utc>>,
    fingerprint: String,
}

fn certificate_fingerprint(certificate_pem: &str) -> Result<String, GatedError> {
    Ok(gated_ca::certificate_sha256_hex_fingerprint(
        &gated_ca::deserialize_certificate(certificate_pem)?,
    )?)
}

impl From<entities::CertificateCredential::Model> for ExistingCertificateCredential {
    fn from(credential: entities::CertificateCredential::Model) -> Self {
        Self {
            id: credential.id,
            label: credential.label,
            date_added: credential.date_added,
            last_used: credential.last_used,
            fingerprint: certificate_fingerprint(&credential.certificate_pem)
                .unwrap_or_else(|_| "Invalid certificate".into()),
        }
    }
}

#[derive(Serialize, ToSchema)]
struct IssuedCertificateCredential {
    credential: ExistingCertificateCredential,
    certificate_pem: String,
}

#[derive(Deserialize, ToSchema)]
struct IssueCertificateCredentialRequest {
    label: String,
    /// PEM-encoded PKCS#10 certificate signing request. The CSR's
    /// self-signature proves the requester holds the matching private key
    /// (proof-of-possession); the certificate is issued over the CSR's public
    /// key.
    csr_pem: String,
}

api_response! {
    enum IssueCertificateCredentialResponse {
        #[oai(status = 201)]
        Issued(Json<IssuedCertificateCredential>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 401)]
        Unauthorized(Json<String>),
    }
}

api_response! {
    enum DeleteCertificateCredentialResponse {
        #[oai(status = 200)]
        Ok,
        #[oai(status = 401)]
        Unauthorized(Json<String>),
        #[oai(status = 404)]
        NotFound,
    }
}

/// Answers 403 unless users may manage their own credentials.
async fn parameters_based_auth(request: Request, next: Next) -> Response {
    let Some(services) = request.extensions().get::<Services>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let db = match services.db_required().await {
        Ok(db) => db,
        Err(error) => return error.into_response(),
    };
    let parameters = match Parameters::Entity::get(&db).await {
        Ok(parameters) => parameters,
        Err(error) => return GatedError::from(error).into_response(),
    };
    drop(db);
    if !parameters.allow_own_credential_management {
        // Enrolling the OTP device MFA requires is always possible.
        let path = request.uri().path();
        let enrolling = request.method() == Method::POST
            && (path.ends_with("/credentials/otp/begin") || path.ends_with("/credentials/otp"));
        let username = request
            .extensions()
            .get::<RequestAuthorization>()
            .and_then(RequestAuthorization::account_username);
        let setup_required = match username {
            Some(username) if enrolling => {
                services
                    .config_provider
                    .lock()
                    .await
                    .mfa_setup_required(username)
                    .await
            }
            _ => Ok(false),
        };
        match setup_required {
            Ok(true) => {}
            Ok(false) => {
                return (StatusCode::FORBIDDEN, "Credential management is disabled")
                    .into_response();
            }
            Err(error) => return error.into_response(),
        }
    }
    next.run(request).await
}

#[utoipa::path(
    get,
    path = "/profile/credentials",
    operation_id = "get_my_credentials"
)]
async fn api_get_credentials_state(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<CredentialsStateResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(CredentialsStateResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    let user = User::try_from(user_model.clone())?;

    let otp_creds = user_model
        .find_related(entities::OtpCredential::Entity)
        .all(&db)
        .await?;
    let password_creds = user_model
        .find_related(entities::PasswordCredential::Entity)
        .all(&db)
        .await?;
    let sso_creds = user_model
        .find_related(entities::SsoCredential::Entity)
        .all(&db)
        .await?;

    let pk_creds = user_model
        .find_related(entities::PublicKeyCredential::Entity)
        .all(&db)
        .await?;

    let cert_creds = user_model
        .find_related(entities::CertificateCredential::Entity)
        .all(&db)
        .await?;

    Ok(CredentialsStateResponse::Ok(Json(CredentialsState {
        password: match password_creds.len() {
            0 => PasswordState::Unset,
            1 => PasswordState::Set,
            _ => PasswordState::MultipleSet,
        },
        otp: otp_creds.into_iter().map(Into::into).collect(),
        public_keys: pk_creds.into_iter().map(Into::into).collect(),
        certificates: cert_creds.into_iter().map(Into::into).collect(),
        sso: sso_creds.into_iter().map(Into::into).collect(),
        credential_policy: user.credential_policy.unwrap_or_default().into(),
        password_policy: entities::Parameters::Entity::get(&db)
            .await?
            .password_policy(),
    })))
}

#[utoipa::path(
    post,
    path = "/profile/credentials/password",
    operation_id = "change_my_password"
)]
async fn api_change_password(
    req: http::request::Parts,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    session: Session,
    session_store: Data<Arc<Mutex<SessionStore>>>,
    _sec_scheme: AnySecurityScheme,
    body: Json<ChangePasswordRequest>,
) -> Result<ChangePasswordResponse, GatedError> {
    if is_ticket_auth(&auth) {
        return Ok(ChangePasswordResponse::Forbidden(Json(
            "not available when signed in with a ticket".into(),
        )));
    }

    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(ChangePasswordResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    // Re-authenticate with the current password. A valid
    // session must not be sufficient to replace the password — that
    // would let a hijacked session take over the account outright.
    let old_cred = AuthCredential::Password(Secret::new(body.old_password.clone()));
    let client_ip = gated_core::logging::http::get_client_ip(&req, Some(&services))
        .await
        .unwrap_or_else(|| "<unknown>".to_owned());
    let reauthenticated = gated_core::auth_throttle::validate_credential_throttled(
        &services,
        &user_model.username,
        &client_ip,
        &old_cred,
    )
    .await?;
    if !reauthenticated {
        info!(target: "audit",
            username = %user_model.username,
            "credential_password_change_reauth_failed"
        );
        return Ok(ChangePasswordResponse::Unauthorized(Json(
            "the current password is wrong".into(),
        )));
    }

    if let Some(violation) = entities::Parameters::Entity::get(&db)
        .await?
        .password_policy()
        .violation(&body.password)
    {
        return Ok(ChangePasswordResponse::BadRequest(Json(violation)));
    }

    entities::PasswordCredential::Entity::delete_many()
        .filter(entities::PasswordCredential::Column::UserId.eq(user_model.id))
        .exec(&db)
        .await
        .map_err(GatedError::from)?;

    let new_credential = entities::PasswordCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(user_model.id),
        ..PasswordCredential::ActiveModel::from(UserPasswordCredential::from_password(
            &body.password.clone().into(),
        ))
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    entities::PasswordCredential::Entity::find()
        .filter(
            entities::PasswordCredential::Column::UserId
                .eq(user_model.id)
                .and(entities::PasswordCredential::Column::Id.ne(new_credential.id)),
        )
        .all(&db)
        .await?;

    // Revoke every OTHER live session for this user, so a
    // password change immediately cuts off access that older (possibly
    // attacker-held) sessions still carry. The current session is left
    // intact so the caller stays logged in.
    let current_session_id = session_store.lock().await.id_of(&session).await;
    let closed =
        end_user_sessions(&services, &session_store, user_model.id, current_session_id).await;

    info!(target: "audit",
        username = %user_model.username,
        sessions_revoked = closed,
        "credential_password_changed"
    );
    Ok(ChangePasswordResponse::Done(Json(PasswordState::Set)))
}

#[utoipa::path(
    post,
    path = "/profile/credentials/public-keys",
    operation_id = "add_my_public_key"
)]
async fn api_create_pk(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<NewPublicKeyCredential>,
) -> Result<CreatePublicKeyCredentialResponse, GatedError> {
    if is_ticket_auth(&auth) {
        return Ok(CreatePublicKeyCredentialResponse::Forbidden(Json(
            "not available when signed in with a ticket".into(),
        )));
    }

    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(CreatePublicKeyCredentialResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    let Ok(openssh_public_key) = normalize_public_key(&body.openssh_public_key) else {
        return Ok(CreatePublicKeyCredentialResponse::BadRequest(Json(
            "not an OpenSSH public key".into(),
        )));
    };

    // A key signs in to SSH on its own, so a browser session proves the
    // strongest factor the user has before adding one.
    if matches!(&*auth, RequestAuthorization::Session(_)) {
        let has_otp = user_model
            .find_related(entities::OtpCredential::Entity)
            .count(&db)
            .await?
            > 0;
        let has_password = user_model
            .find_related(entities::PasswordCredential::Entity)
            .count(&db)
            .await?
            > 0;
        if has_otp || has_password {
            let confirmation = RevealConfirmation {
                reason: None,
                password: body.password.clone().filter(|_| !has_otp),
                otp: body.otp.clone().filter(|_| has_otp),
            };
            match verify_step_up(&services, &db, &user_model.username, 0, &confirmation).await? {
                Ok(_) => {}
                Err(StepUpFailure::BadRequest) => {
                    return Ok(CreatePublicKeyCredentialResponse::BadRequest(Json(
                        if has_otp {
                            "confirmation required: otp"
                        } else {
                            "confirmation required: password"
                        }
                        .into(),
                    )));
                }
                Err(StepUpFailure::Unauthorized) => {
                    return Ok(CreatePublicKeyCredentialResponse::Unauthorized(Json(
                        "confirmation rejected".into(),
                    )));
                }
                Err(StepUpFailure::RateLimited) => {
                    return Ok(CreatePublicKeyCredentialResponse::RateLimited);
                }
            }
        }
    }

    let object = PublicKeyCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(user_model.id),
        date_added: Set(Some(Utc::now())),
        last_used: Set(None),
        label: Set(body.label.clone()),
        openssh_public_key: Set(openssh_public_key),
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    info!(target: "audit",
        username = %user_model.username,
        credential_id = %object.id,
        label = %body.label,
        "credential_public_key_added"
    );
    Ok(CreatePublicKeyCredentialResponse::Created(Json(
        object.into(),
    )))
}

#[utoipa::path(
    delete,
    path = "/profile/credentials/public-keys/{id}",
    operation_id = "delete_my_public_key"
)]
async fn api_delete_pk(
    id: Path<Uuid>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteCredentialResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(DeleteCredentialResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    let Some(model) = user_model
        .find_related(entities::PublicKeyCredential::Entity)
        .filter(entities::PublicKeyCredential::Column::Id.eq(id.0))
        .one(&db)
        .await?
    else {
        return Ok(DeleteCredentialResponse::NotFound);
    };

    model.delete(&db).await?;
    info!(target: "audit",
        username = %user_model.username,
        credential_id = %id.0,
        "credential_public_key_deleted"
    );
    Ok(DeleteCredentialResponse::Deleted)
}

/// Start OTP enrollment. The server generates the secret,
/// stashes it pending confirmation, and returns only a provisioning URI.
/// The client must then prove possession via [`Self::api_create_otp`].
#[utoipa::path(
    post,
    path = "/profile/credentials/otp/begin",
    operation_id = "begin_my_otp"
)]
async fn api_begin_otp(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<BeginOtpEnrollmentResponse, GatedError> {
    if is_ticket_auth(&auth) {
        return Ok(BeginOtpEnrollmentResponse::Forbidden(Json(
            "not available when signed in with a ticket".into(),
        )));
    }

    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(BeginOtpEnrollmentResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    let key = generate_key();
    let provisioning_uri = generate_setup_url(&key, &user_model.username)
        .expose_secret()
        .clone();

    {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut pending = PENDING_OTP_ENROLLMENTS.lock().unwrap();
        prune_pending_enrollments(&mut pending);
        pending.insert(user_model.id, (key, Instant::now()));
    }

    info!(target: "audit",username = %user_model.username, "credential_otp_enrollment_started");
    Ok(BeginOtpEnrollmentResponse::Created(Json(
        BeginOtpEnrollment { provisioning_uri },
    )))
}

/// Confirm OTP enrollment. Requires a live code for the
/// server-generated secret started by [`Self::api_begin_otp`]; only then
/// is the credential persisted and the policy upgraded to require OTP.
#[utoipa::path(post, path = "/profile/credentials/otp", operation_id = "add_my_otp")]
async fn api_create_otp(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<ConfirmOtpCredential>,
) -> Result<CreateOtpCredentialResponse, GatedError> {
    if is_ticket_auth(&auth) {
        return Ok(CreateOtpCredentialResponse::Forbidden(Json(
            "not available when signed in with a ticket".into(),
        )));
    }

    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(CreateOtpCredentialResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    let mut user: User = user_model.clone().try_into()?;
    let username = user_model.username.clone();

    // Look up the pending server-generated secret for this user.
    let pending_secret = {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut pending = PENDING_OTP_ENROLLMENTS.lock().unwrap();
        prune_pending_enrollments(&mut pending);
        pending.get(&user_model.id).map(|(key, _)| key.clone())
    };
    let Some(secret) = pending_secret else {
        // No enrollment in progress (or it expired) — refuse.
        return Ok(CreateOtpCredentialResponse::Forbidden(Json(
            "no MFA setup is in progress or it expired; start the setup again".into(),
        )));
    };

    // Proof-of-possession: a valid live code must be presented before
    // the credential is stored and the policy upgraded.
    match check_totp(&body.otp, &secret) {
        TotpCheck::Valid => {}
        TotpCheck::Invalid => {
            return Ok(CreateOtpCredentialResponse::Forbidden(Json(
                "the code is wrong; check that the authenticator app was set up with this key and that the device time is correct".into(),
            )));
        }
        TotpCheck::Reused => {
            return Ok(CreateOtpCredentialResponse::Forbidden(Json(
                "this code was already used; wait for the next one".into(),
            )));
        }
    }

    // Consume the pending enrollment so the secret cannot be reused.
    #[allow(clippy::unwrap_used, reason = "panic on poison")]
    PENDING_OTP_ENROLLMENTS
        .lock()
        .unwrap()
        .remove(&user_model.id);

    let object = entities::OtpCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(user_model.id),
        secret_key: Set(secret.expose_secret().clone()),
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    let details = user_model.load_details(&db).await?;
    user.credential_policy = Some(
        user.credential_policy
            .unwrap_or_default()
            .upgrade_to_otp(details.credentials.as_slice()),
    );

    entities::User::ActiveModel::try_from(user)?
        .update(&db)
        .await?;

    info!(target: "audit",
        username = %username,
        credential_id = %object.id,
        "credential_otp_added"
    );
    Ok(CreateOtpCredentialResponse::Created(Json(object.into())))
}

#[utoipa::path(
    delete,
    path = "/profile/credentials/otp/{id}",
    operation_id = "delete_my_otp"
)]
async fn api_delete_otp(
    id: Path<Uuid>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteCredentialResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(DeleteCredentialResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    let Some(model) = user_model
        .find_related(entities::OtpCredential::Entity)
        .filter(entities::OtpCredential::Column::Id.eq(id.0))
        .one(&db)
        .await?
    else {
        return Ok(DeleteCredentialResponse::NotFound);
    };

    let devices = entities::OtpCredential::Entity::find()
        .filter(entities::OtpCredential::Column::UserId.eq(user_model.id))
        .count(&db)
        .await?;
    if devices <= 1 && Parameters::Entity::get(&db).await?.mfa_required {
        return Ok(DeleteCredentialResponse::Forbidden(Json(
            "MFA is required; add another device before removing the last one".into(),
        )));
    }

    model.delete(&db).await?;

    // If no OTP credentials remain, remove OTP from the user's credential policy
    let remaining = devices.saturating_sub(1);

    let username = user_model.username.clone();
    if remaining == 0 {
        let policy: Option<gated_common::UserRequireCredentialsPolicy> =
            serde_json::from_value(user_model.credential_policy.clone())
                .ok()
                .flatten();
        if let Some(policy) = policy {
            let new_policy = policy.downgrade_from_otp();
            let mut active: entities::User::ActiveModel = user_model.into();
            active.credential_policy =
                sea_orm::ActiveValue::Set(serde_json::to_value(&new_policy).unwrap_or_default());
            active.update(&db).await?;
        }
    }

    info!(target: "audit",
        username = %username,
        credential_id = %id.0,
        remaining_otp = remaining,
        "credential_otp_deleted"
    );
    Ok(DeleteCredentialResponse::Deleted)
}

#[utoipa::path(
    post,
    path = "/profile/credentials/certificates",
    operation_id = "issue_my_certificate"
)]
async fn api_issue_certificate(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    body: Json<IssueCertificateCredentialRequest>,
) -> Result<IssueCertificateCredentialResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(IssueCertificateCredentialResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    // Fetch CA params
    let params = Parameters::Entity::get(&db).await?;
    let ca = gated_ca::deserialize_ca(&params.ca_certificate_pem, &params.ca_private_key_pem)?;
    // Require a CSR and verify its proof-of-possession before issuing.
    // A self-service caller may only obtain a certificate for
    // a key it can prove it holds.
    let csr_pem = body.csr_pem.trim();
    let client_cert = match gated_ca::issue_client_certificate_from_csr(&ca, csr_pem, user_model.id)
    {
        Ok(cert) => cert,
        // Malformed / unsigned / unsupported CSR is client error.
        Err(gated_ca::CaError::InvalidKeyFormat) => {
            return Ok(IssueCertificateCredentialResponse::BadRequest(Json(
                "the CSR is malformed, unsigned or uses an unsupported key type".into(),
            )));
        }
        Err(err) => return Err(err.into()),
    };
    let client_cert_pem = gated_ca::certificate_to_pem(&client_cert)?;

    let object = CertificateCredential::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(user_model.id),
        date_added: Set(Some(Utc::now())),
        last_used: Set(None),
        label: Set(body.label.clone()),
        certificate_pem: Set(client_cert_pem.clone()),
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    info!(target: "audit",
        username = %user_model.username,
        credential_id = %object.id,
        label = %body.label,
        "credential_certificate_issued"
    );
    Ok(IssueCertificateCredentialResponse::Issued(Json(
        IssuedCertificateCredential {
            credential: object.clone().into(),
            certificate_pem: client_cert_pem,
        },
    )))
}

#[utoipa::path(
    delete,
    path = "/profile/credentials/certificates/{id}",
    operation_id = "revoke_my_certificate"
)]
async fn api_revoke_certificate(
    id: Path<Uuid>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
) -> Result<DeleteCertificateCredentialResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
        return Ok(DeleteCertificateCredentialResponse::Unauthorized(Json(
            "not signed in".into(),
        )));
    };

    let Some(model) = user_model
        .find_related(entities::CertificateCredential::Entity)
        .filter(entities::CertificateCredential::Column::Id.eq(id.0))
        .one(&db)
        .await?
    else {
        return Ok(DeleteCertificateCredentialResponse::NotFound);
    };

    // Add to revocation list
    let cert = gated_ca::deserialize_certificate(&model.certificate_pem)?;
    entities::CertificateRevocation::ActiveModel {
        id: Set(Uuid::new_v4()),
        date_added: Set(Utc::now()),
        serial_number_base64: Set(gated_ca::serialize_certificate_serial(&cert)),
    }
    .insert(&db)
    .await?;

    model.delete(&db).await?;
    info!(target: "audit",
        username = %user_model.username,
        credential_id = %id.0,
        "credential_certificate_revoked"
    );
    Ok(DeleteCertificateCredentialResponse::Ok)
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_credentials_state,
        api_change_password,
        api_create_pk,
        api_delete_pk,
        api_begin_otp,
        api_create_otp,
        api_delete_otp,
        api_issue_certificate,
        api_revoke_certificate,
    )
    .route_layer(from_fn(forbid_ticket_sessions))
    .route_layer(from_fn(require_auth))
    .route_layer(from_fn(parameters_based_auth))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A pasted key is stored as `<type> <base64>`, without its comment,
    // which is what SSH authentication compares against.
    #[test]
    fn registered_public_keys_are_stored_without_their_comment() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGbuYd0ewTYUH9VEelpXA4JSEBpU9g4WFukYUQXNCPiD alice@laptop\n";
        assert_eq!(
            normalize_public_key(key).expect("test"),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGbuYd0ewTYUH9VEelpXA4JSEBpU9g4WFukYUQXNCPiD"
        );
        assert!(normalize_public_key("not a key").is_err());
    }

    #[test]
    fn public_key_credentials_expose_the_full_key_and_its_fingerprint() {
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDP/CQS05AYYvEeZ3X6EPSE4liuLuP7w6p7HgIydOvbq";
        let credential = ExistingPublicKeyCredential::from(PublicKeyCredential::Model {
            id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            label: "laptop".into(),
            date_added: None,
            last_used: None,
            openssh_public_key: key.into(),
        });
        assert_eq!(credential.openssh_public_key, key);
        assert_eq!(
            credential.fingerprint,
            russh::keys::PublicKey::from_openssh(key)
                .expect("key")
                .fingerprint(russh::keys::HashAlg::Sha256)
                .to_string()
        );
    }
}
