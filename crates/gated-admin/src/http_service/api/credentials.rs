use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use gated_common::auth::AuthCredential;
use gated_common::helpers::otp::{generate_key, generate_setup_url, verify_totp, OtpSecretKey};
use gated_common::{
    GatedError, Secret, User, UserPasswordCredential, UserRequireCredentialsPolicy,
};
use gated_core::{ConfigProvider, Services};
use gated_db_entities::{
    self as entities, CertificateCredential, Parameters, PasswordCredential, PublicKeyCredential,
};
use http::StatusCode;
use poem::session::Session;
use poem::web::Data;
use poem::{Endpoint, EndpointExt, FromRequest, IntoResponse};
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Enum, Object, OpenApi};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, PaginatorTrait, QueryFilter, Set,
};
use tokio::sync::Mutex;
use tracing::info;
use uuid::Uuid;

use super::common::{get_user, is_ticket_auth};
use crate::http_service::api::AnySecurityScheme;
use crate::http_service::common::{endpoint_auth, RequestAuthorization};
use crate::http_service::session::SessionStore;

pub struct Api;

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

#[derive(Enum)]
enum PasswordState {
    Unset,
    Set,
    MultipleSet,
}

#[derive(Object)]
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

#[derive(Object)]
struct ChangePasswordRequest {
    /// The caller's current password, re-verified before the
    /// change is applied (a session alone must not be enough).
    old_password: String,
    password: String,
}

#[derive(ApiResponse)]
enum ChangePasswordResponse {
    #[oai(status = 201)]
    Done(Json<PasswordState>),
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 403)]
    Forbidden,
}

#[derive(Object)]
pub struct CredentialsState {
    password: PasswordState,
    otp: Vec<ExistingOtpCredential>,
    public_keys: Vec<ExistingPublicKeyCredential>,
    certificates: Vec<ExistingCertificateCredential>,
    sso: Vec<ExistingSsoCredential>,
    credential_policy: UserRequireCredentialsPolicy,
}

#[derive(ApiResponse)]
#[allow(clippy::large_enum_variant)]
enum CredentialsStateResponse {
    #[oai(status = 200)]
    Ok(Json<CredentialsState>),
    #[oai(status = 401)]
    Unauthorized,
}

#[derive(Object)]
struct NewPublicKeyCredential {
    label: String,
    openssh_public_key: String,
}

#[derive(Object)]
struct ExistingPublicKeyCredential {
    id: Uuid,
    label: String,
    date_added: Option<DateTime<Utc>>,
    last_used: Option<DateTime<Utc>>,
    abbreviated: String,
}

fn abbreviate_public_key(k: &str) -> String {
    let l = 10;
    if k.len() <= l {
        return k.to_string(); // Return the full key if it's shorter than or equal to `l`.
    }

    format!(
        "{}...{}",
        &k[..l.min(k.len())],            // Take the first `l` characters.
        &k[k.len().saturating_sub(l)..]  // Take the last `l` characters safely.
    )
}

impl From<entities::PublicKeyCredential::Model> for ExistingPublicKeyCredential {
    fn from(credential: entities::PublicKeyCredential::Model) -> Self {
        Self {
            id: credential.id,
            label: credential.label,
            date_added: credential.date_added,
            last_used: credential.last_used,
            abbreviated: abbreviate_public_key(&credential.openssh_public_key),
        }
    }
}
#[derive(ApiResponse)]
enum CreatePublicKeyCredentialResponse {
    #[oai(status = 201)]
    Created(Json<ExistingPublicKeyCredential>),
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 403)]
    Forbidden,
}

#[derive(ApiResponse)]
enum DeleteCredentialResponse {
    #[oai(status = 204)]
    Deleted,
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 404)]
    NotFound,
}

/// The secret is generated server-side; enrollment is confirmed
/// by sending a live code from the authenticator, proving possession.
#[derive(Object)]
struct ConfirmOtpCredential {
    otp: String,
}

/// Response of starting an OTP enrollment: an `otpauth://` provisioning URI
/// for the server-generated secret. The raw secret is never returned.
#[derive(Object)]
struct BeginOtpEnrollment {
    provisioning_uri: String,
}

#[derive(ApiResponse)]
enum BeginOtpEnrollmentResponse {
    #[oai(status = 201)]
    Created(Json<BeginOtpEnrollment>),
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 403)]
    Forbidden,
}

#[derive(Object)]
struct ExistingOtpCredential {
    id: Uuid,
}

impl From<entities::OtpCredential::Model> for ExistingOtpCredential {
    fn from(credential: entities::OtpCredential::Model) -> Self {
        Self { id: credential.id }
    }
}

#[derive(ApiResponse)]
enum CreateOtpCredentialResponse {
    #[oai(status = 201)]
    Created(Json<ExistingOtpCredential>),
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 403)]
    Forbidden,
}

#[derive(Object)]
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

#[derive(Object)]
struct IssuedCertificateCredential {
    credential: ExistingCertificateCredential,
    certificate_pem: String,
}

#[derive(Object)]
struct IssueCertificateCredentialRequest {
    label: String,
    /// PEM-encoded PKCS#10 certificate signing request. The CSR's
    /// self-signature proves the requester holds the matching private key
    /// (proof-of-possession); the certificate is issued over the CSR's public
    /// key.
    csr_pem: String,
}

#[derive(ApiResponse)]
enum IssueCertificateCredentialResponse {
    #[oai(status = 201)]
    Issued(Json<IssuedCertificateCredential>),
    #[oai(status = 400)]
    BadRequest,
    #[oai(status = 401)]
    Unauthorized,
}

#[derive(ApiResponse)]
enum DeleteCertificateCredentialResponse {
    #[oai(status = 200)]
    Ok,
    #[oai(status = 401)]
    Unauthorized,
    #[oai(status = 404)]
    NotFound,
}

pub fn parameters_based_auth<E: Endpoint + 'static>(e: E) -> impl Endpoint {
    e.around(|ep, req| async move {
        let services = Data::<&Services>::from_request_without_body(&req).await?;
        let parameters = Parameters::Entity::get(&services.db_required().await?)
            .await
            .map_err(GatedError::from)?;
        if !parameters.allow_own_credential_management {
            return Ok(poem::Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body("Credential management is disabled")
                .into_response());
        }
        Ok(endpoint_auth(ep).call(req).await?.into_response())
    })
}

/// Close every live proxy session belonging to `username` except `keep`,
/// immediately revoking any access the session still held. Returns how many
/// sessions were closed.
async fn invalidate_other_sessions(
    services: &Services,
    username: &str,
    keep: Option<Uuid>,
) -> usize {
    let state = services.state.write().await;
    let mut closed = 0;
    for (id, session_state) in state.sessions.iter() {
        if Some(*id) == keep {
            continue;
        }
        let mut session_state = session_state.lock().await;
        let belongs = session_state
            .user_info
            .as_ref()
            .is_some_and(|u| u.username == username);
        if belongs {
            session_state.handle.close();
            closed += 1;
        }
    }
    closed
}

#[OpenApi]
impl Api {
    #[oai(
        path = "/profile/credentials",
        method = "get",
        operation_id = "get_my_credentials",
        transform = "parameters_based_auth"
    )]
    async fn api_get_credentials_state(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<CredentialsStateResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(*auth, &db).await? else {
            return Ok(CredentialsStateResponse::Unauthorized);
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
            credential_policy: user.credential_policy.unwrap_or_default(),
        })))
    }

    #[oai(
        path = "/profile/credentials/password",
        method = "post",
        operation_id = "change_my_password",
        transform = "parameters_based_auth"
    )]
    async fn api_change_password(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        session: &Session,
        session_store: Data<&Arc<Mutex<SessionStore>>>,
        body: Json<ChangePasswordRequest>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<ChangePasswordResponse, GatedError> {
        if is_ticket_auth(&auth) {
            return Ok(ChangePasswordResponse::Forbidden);
        }

        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(ChangePasswordResponse::Unauthorized);
        };

        // Re-authenticate with the current password. A valid
        // session must not be sufficient to replace the password — that
        // would let a hijacked session take over the account outright.
        let old_cred = AuthCredential::Password(Secret::new(body.old_password.clone()));
        let reauthenticated = {
            let mut cp = services.config_provider.lock().await;
            cp.validate_credential(&user_model.username, &old_cred)
                .await?
        };
        if !reauthenticated {
            info!(target: "audit",
                username = %user_model.username,
                "credential_password_change_reauth_failed"
            );
            return Ok(ChangePasswordResponse::Unauthorized);
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
        let current_session_id = {
            let store = session_store.lock().await;
            match store.handle_for(session) {
                Some(handle) => Some(handle.lock().await.id()),
                None => None,
            }
        };
        let closed = session_store
            .lock()
            .await
            .revoke_other_sessions(&user_model.username, current_session_id)
            .await
            + invalidate_other_sessions(&services, &user_model.username, current_session_id).await;

        info!(target: "audit",
            username = %user_model.username,
            sessions_revoked = closed,
            "credential_password_changed"
        );
        Ok(ChangePasswordResponse::Done(Json(PasswordState::Set)))
    }

    #[oai(
        path = "/profile/credentials/public-keys",
        method = "post",
        operation_id = "add_my_public_key",
        transform = "parameters_based_auth"
    )]
    async fn api_create_pk(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        body: Json<NewPublicKeyCredential>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<CreatePublicKeyCredentialResponse, GatedError> {
        if is_ticket_auth(&auth) {
            return Ok(CreatePublicKeyCredentialResponse::Forbidden);
        }

        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(CreatePublicKeyCredentialResponse::Unauthorized);
        };

        let object = PublicKeyCredential::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(user_model.id),
            date_added: Set(Some(Utc::now())),
            last_used: Set(None),
            label: Set(body.label.clone()),
            openssh_public_key: Set(body.openssh_public_key.clone()),
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

    #[oai(
        path = "/profile/credentials/public-keys/:id",
        method = "delete",
        operation_id = "delete_my_public_key",
        transform = "parameters_based_auth"
    )]
    async fn api_delete_pk(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<DeleteCredentialResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(DeleteCredentialResponse::Unauthorized);
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
    #[oai(
        path = "/profile/credentials/otp/begin",
        method = "post",
        operation_id = "begin_my_otp",
        transform = "parameters_based_auth"
    )]
    async fn api_begin_otp(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<BeginOtpEnrollmentResponse, GatedError> {
        if is_ticket_auth(&auth) {
            return Ok(BeginOtpEnrollmentResponse::Forbidden);
        }

        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(BeginOtpEnrollmentResponse::Unauthorized);
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
    #[oai(
        path = "/profile/credentials/otp",
        method = "post",
        operation_id = "add_my_otp",
        transform = "parameters_based_auth"
    )]
    async fn api_create_otp(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        body: Json<ConfirmOtpCredential>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<CreateOtpCredentialResponse, GatedError> {
        if is_ticket_auth(&auth) {
            return Ok(CreateOtpCredentialResponse::Forbidden);
        }

        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(CreateOtpCredentialResponse::Unauthorized);
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
            return Ok(CreateOtpCredentialResponse::Forbidden);
        };

        // Proof-of-possession: a valid live code must be presented before
        // the credential is stored and the policy upgraded.
        if !verify_totp(&body.otp, &secret) {
            return Ok(CreateOtpCredentialResponse::Forbidden);
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

    #[oai(
        path = "/profile/credentials/otp/:id",
        method = "delete",
        operation_id = "delete_my_otp",
        transform = "parameters_based_auth"
    )]
    async fn api_delete_otp(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<DeleteCredentialResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(DeleteCredentialResponse::Unauthorized);
        };

        let Some(model) = user_model
            .find_related(entities::OtpCredential::Entity)
            .filter(entities::OtpCredential::Column::Id.eq(id.0))
            .one(&db)
            .await?
        else {
            return Ok(DeleteCredentialResponse::NotFound);
        };

        model.delete(&db).await?;

        // If no OTP credentials remain, remove OTP from the user's credential policy
        let remaining = entities::OtpCredential::Entity::find()
            .filter(entities::OtpCredential::Column::UserId.eq(user_model.id))
            .count(&db)
            .await?;

        let username = user_model.username.clone();
        if remaining == 0 {
            let policy: Option<gated_common::UserRequireCredentialsPolicy> =
                serde_json::from_value(user_model.credential_policy.clone())
                    .ok()
                    .flatten();
            if let Some(policy) = policy {
                let new_policy = policy.downgrade_from_otp();
                let mut active: entities::User::ActiveModel = user_model.into();
                active.credential_policy = sea_orm::ActiveValue::Set(
                    serde_json::to_value(&new_policy).unwrap_or_default(),
                );
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

    #[oai(
        path = "/profile/credentials/certificates",
        method = "post",
        operation_id = "issue_my_certificate",
        transform = "parameters_based_auth"
    )]
    async fn api_issue_certificate(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        body: Json<IssueCertificateCredentialRequest>,
    ) -> Result<IssueCertificateCredentialResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(IssueCertificateCredentialResponse::Unauthorized);
        };

        // Fetch CA params
        let params = Parameters::Entity::get(&db).await?;
        let ca = gated_ca::deserialize_ca(&params.ca_certificate_pem, &params.ca_private_key_pem)?;
        // Require a CSR and verify its proof-of-possession before issuing.
        // A self-service caller may only obtain a certificate for
        // a key it can prove it holds.
        let csr_pem = body.csr_pem.trim();
        let client_cert =
            match gated_ca::issue_client_certificate_from_csr(&ca, csr_pem, user_model.id) {
                Ok(cert) => cert,
                // Malformed / unsigned / unsupported CSR is client error.
                Err(gated_ca::CaError::InvalidKeyFormat) => {
                    return Ok(IssueCertificateCredentialResponse::BadRequest);
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

    #[oai(
        path = "/profile/credentials/certificates/:id",
        method = "delete",
        operation_id = "revoke_my_certificate",
        transform = "parameters_based_auth"
    )]
    async fn api_revoke_certificate(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        id: Path<Uuid>,
    ) -> Result<DeleteCertificateCredentialResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(&auth, &db).await? else {
            return Ok(DeleteCertificateCredentialResponse::Unauthorized);
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
}
