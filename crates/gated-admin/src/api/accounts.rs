use super::reveal_guard::{RevealConfirmation, RevealGuard};
use crate::http_service::common::RequestAuthorization;
use axum::extract::{Path, Query};
use chrono::{DateTime, Utc};
use gated_common::web::{Data, Json};
use gated_common::{AccountCredentials, GatedError};
use gated_common::{api_response, api_routes};
use gated_core::{ConfigProvider, Services, SharedDatabaseConnection};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Instant;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;
static REVEAL_GUARD: LazyLock<tokio::sync::Mutex<RevealGuard>> =
    LazyLock::new(|| tokio::sync::Mutex::new(RevealGuard::default()));
use gated_db_entities::{Account, ManagementAudit, Target, TargetAccount};
use sea_orm::query::JsonValue;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, ModelTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
pub struct AccountSummary {
    pub id: i32,
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub rotation_due_at: Option<DateTime<Utc>>,
    pub reference_count: u32,
}

#[derive(Serialize, ToSchema)]
pub struct AccountDetail {
    #[serde(flatten)]
    pub summary: AccountSummary,
    pub credentials_schema: Value,
    /// Stored credentials with every sensitive value removed, so edit forms
    /// can prefill usernames, engines, namespaces and CA certificates.
    pub credentials_public: Value,
}

#[derive(Deserialize, ToSchema)]
pub struct AccountCreate {
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub credentials: Value,
    pub tags: Option<Vec<String>>,
    pub rotation_due_at: Option<DateTime<Utc>>,
    /// Step-up confirmation; required for browser-session callers.
    pub confirmation: Option<RevealConfirmation>,
}

#[derive(Deserialize, ToSchema)]
pub struct AccountUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub credentials: Option<Value>,
    pub tags: Option<Vec<String>>,
    pub rotation_due_at: Option<DateTime<Utc>>,
    // JSON null cannot be distinguished from absent on Option<T>, so a
    // companion bool is the explicit signal to clear rotation_due_at.
    pub clear_rotation_due_at: Option<bool>,
    /// Step-up confirmation; required for browser-session callers.
    pub confirmation: Option<RevealConfirmation>,
}

#[derive(Serialize, ToSchema)]
pub struct AccountReveal {
    pub credentials: AccountCredentials,
}

#[derive(Serialize, ToSchema)]
pub struct AccountReference {
    pub target_id: Uuid,
    pub target_name: String,
    pub target_kind: String,
    pub role: String,
}

#[derive(Serialize, ToSchema)]
pub struct AccountDeleteConflict {
    pub error: String,
    pub reference_count: u32,
    pub references: Vec<AccountReference>,
}

api_response! {
    enum ListAccountsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<AccountSummary>>),
    }
}

api_response! {
    enum CreateAccountResponse {
        #[oai(status = 201)]
        Created(Json<AccountSummary>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 401)]
        Unauthorized,
        #[oai(status = 429)]
        RateLimited,
        #[oai(status = 409)]
        Conflict(Json<String>),
        #[oai(status = 422)]
        UnprocessableEntity(Json<String>),
    }
}

api_response! {
    #[allow(clippy::large_enum_variant)]
    enum GetAccountResponse {
        #[oai(status = 200)]
        Ok(Json<AccountDetail>),
        #[oai(status = 404)]
        NotFound,
        #[oai(status = 422)]
        UnprocessableEntity(Json<String>),
    }
}

api_response! {
    enum UpdateAccountResponse {
        #[oai(status = 200)]
        Ok(Json<AccountSummary>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 401)]
        Unauthorized,
        #[oai(status = 429)]
        RateLimited,
        #[oai(status = 404)]
        NotFound,
        #[oai(status = 409)]
        Conflict(Json<String>),
        #[oai(status = 422)]
        UnprocessableEntity(Json<String>),
    }
}

api_response! {
    enum DeleteAccountResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 404)]
        NotFound,
        #[oai(status = 409)]
        Conflict(Json<AccountDeleteConflict>),
    }
}

api_response! {
    enum RevealAccountResponse {
        #[oai(status = 400)]
        BadRequest,
        #[oai(status = 401)]
        Unauthorized,
        #[oai(status = 429)]
        RateLimited,

        #[oai(status = 200)]
        Ok(Json<AccountReveal>, #[oai(header = "Cache-Control")] String),
        #[oai(status = 404)]
        NotFound,
        #[oai(status = 422)]
        UnprocessableEntity(Json<String>),
    }
}

api_response! {
    enum AccountReferencesResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<AccountReference>>),
        #[oai(status = 404)]
        NotFound,
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct GetAllAccountsQuery {
    kind: Option<String>,
    tag: Option<String>,
    q: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
}

#[utoipa::path(
    get,
    path = "/accounts",
    operation_id = "get_accounts",
    params(GetAllAccountsQuery)
)]
async fn api_get_all_accounts(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    Query(query): Query<GetAllAccountsQuery>,
) -> Result<ListAccountsResponse, GatedError> {
    let GetAllAccountsQuery {
        kind,
        tag,
        q,
        page,
        page_size,
    } = query;
    let db = gated_core::db_required(&db).await?;
    let page = page.unwrap_or(1).max(1);
    let page_size = page_size.unwrap_or(100).clamp(1, 500);
    let offset = (page - 1) * page_size;

    let mut query = Account::Entity::find().order_by_asc(Account::Column::Name);

    if let Some(kind) = kind {
        query = query.filter(Account::Column::Kind.eq(kind));
    }
    if let Some(tag) = tag {
        query = query.filter(Account::Column::Tags.contains(format!("\"{tag}\"")));
    }
    if let Some(q) = q {
        query = query.filter(
            Account::Column::Name
                .contains(q.clone())
                .or(Account::Column::Description.contains(q)),
        );
    }

    let accounts = query.offset(offset).limit(page_size).all(&db).await?;
    let mut summaries = Vec::with_capacity(accounts.len());
    for account in accounts {
        summaries.push(account_summary(&db, account).await?);
    }

    Ok(ListAccountsResponse::Ok(Json(summaries)))
}

#[utoipa::path(post, path = "/accounts", operation_id = "create_account")]
async fn api_create_account(
    db: Data<SharedDatabaseConnection>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<AccountCreate>,
) -> Result<CreateAccountResponse, GatedError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Ok(CreateAccountResponse::BadRequest(Json(
            "name is required".into(),
        )));
    }

    let credentials = match parse_credentials_for_kind(&body.kind, body.credentials.clone()) {
        Ok(credentials) => credentials,
        Err(message) => return Ok(CreateAccountResponse::UnprocessableEntity(Json(message))),
    };
    if let Err(message) = validate_required_credentials(&credentials) {
        return Ok(CreateAccountResponse::UnprocessableEntity(Json(message)));
    }

    let db = gated_core::db_required(&db).await?;
    let existing = Account::Entity::find()
        .filter(Account::Column::Name.eq(name))
        .one(&db)
        .await?;
    if existing.is_some() {
        return Ok(CreateAccountResponse::Conflict(Json(
            "name already exists".into(),
        )));
    }

    let step_up =
        match require_step_up(&auth, &services, &db, 0, body.confirmation.as_ref()).await? {
            Ok(step_up) => step_up,
            Err(StepUpFailure::BadRequest) => {
                return Ok(CreateAccountResponse::BadRequest(Json(
                    "confirmation is required".into(),
                )));
            }
            Err(StepUpFailure::Unauthorized) => return Ok(CreateAccountResponse::Unauthorized),
            Err(StepUpFailure::RateLimited) => return Ok(CreateAccountResponse::RateLimited),
        };

    let mut account = insert_account(
        &db,
        name.to_owned(),
        body.description.clone(),
        credentials,
        body.tags.clone(),
        None,
    )
    .await?;
    if body.rotation_due_at.is_some() {
        let mut model: Account::ActiveModel = account.into();
        model.rotation_due_at = Set(body.rotation_due_at);
        account = model.update(&db).await?;
    }
    if let Some(step_up) = step_up {
        insert_account_audit_log(
            &db,
            &account,
            &step_up,
            "account.create",
            "Admin account created",
        )
        .await?;
    }
    let summary = account_summary(&db, account).await?;

    Ok(CreateAccountResponse::Created(Json(summary)))
}

#[utoipa::path(get, path = "/accounts/{id}", operation_id = "get_account")]
async fn api_get_account(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetAccountResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let Some(account) = Account::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(GetAccountResponse::NotFound);
    };
    let credentials = match stored_credentials(&account) {
        Ok(credentials) => credentials,
        Err(message) => return Ok(GetAccountResponse::UnprocessableEntity(Json(message))),
    };
    let summary = account_summary(&db, account).await?;

    Ok(GetAccountResponse::Ok(Json(AccountDetail {
        summary,
        credentials_schema: credentials_schema(&credentials),
        credentials_public: credentials_public(&credentials),
    })))
}

#[utoipa::path(put, path = "/accounts/{id}", operation_id = "update_account")]
async fn api_update_account(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<AccountUpdate>,
) -> Result<UpdateAccountResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let Some(account) = Account::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(UpdateAccountResponse::NotFound);
    };

    if let Some(name) = &body.name {
        let name = name.trim();
        if name.is_empty() {
            return Ok(UpdateAccountResponse::BadRequest(Json(
                "name is required".into(),
            )));
        }
        let existing = Account::Entity::find()
            .filter(Account::Column::Name.eq(name))
            .filter(Account::Column::Id.ne(id.0))
            .one(&db)
            .await?;
        if existing.is_some() {
            return Ok(UpdateAccountResponse::Conflict(Json(
                "name already exists".into(),
            )));
        }
    }

    let credentials = match &body.credentials {
        Some(value) => match parse_credentials_for_kind(&account.kind, value.clone()) {
            Ok(incoming) => {
                // Blank secrets mean "keep the stored value", so a
                // username change does not wipe the password.
                let merged = match stored_credentials(&account) {
                    Ok(stored) => merge_credentials(&stored, incoming),
                    Err(_) => incoming,
                };
                if let Err(message) = validate_required_credentials(&merged) {
                    return Ok(UpdateAccountResponse::UnprocessableEntity(Json(message)));
                }
                Some(merged)
            }
            Err(message) => {
                return Ok(UpdateAccountResponse::UnprocessableEntity(Json(message)));
            }
        },
        None => None,
    };

    let step_up = match require_step_up(
        &auth,
        &services,
        &db,
        account.id,
        body.confirmation.as_ref(),
    )
    .await?
    {
        Ok(step_up) => step_up,
        Err(StepUpFailure::BadRequest) => {
            return Ok(UpdateAccountResponse::BadRequest(Json(
                "confirmation is required".into(),
            )));
        }
        Err(StepUpFailure::Unauthorized) => return Ok(UpdateAccountResponse::Unauthorized),
        Err(StepUpFailure::RateLimited) => return Ok(UpdateAccountResponse::RateLimited),
    };

    let mut model: Account::ActiveModel = account.into();
    if let Some(name) = &body.name {
        model.name = Set(name.trim().to_owned());
    }
    if let Some(description) = &body.description {
        model.description = Set(Some(description.clone()));
    }
    if let Some(credentials) = credentials {
        model.credentials = Set(serde_json::to_string(&credentials).map_err(GatedError::from)?);
    }
    if body.tags.is_some() {
        model.tags = Set(serialize_tags(body.tags.clone()).map_err(GatedError::from)?);
    }
    if body.clear_rotation_due_at == Some(true) {
        model.rotation_due_at = Set(None);
    } else if body.rotation_due_at.is_some() {
        model.rotation_due_at = Set(body.rotation_due_at);
    }
    model.updated_at = Set(Utc::now());

    let account = model.update(&db).await?;
    if let Some(step_up) = step_up {
        insert_account_audit_log(
            &db,
            &account,
            &step_up,
            "account.update",
            "Admin account updated",
        )
        .await?;
    }
    let summary = account_summary(&db, account).await?;
    Ok(UpdateAccountResponse::Ok(Json(summary)))
}

#[utoipa::path(delete, path = "/accounts/{id}", operation_id = "delete_account")]
async fn api_delete_account(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteAccountResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let Some(account) = Account::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(DeleteAccountResponse::NotFound);
    };

    let references = account_references(&db, id.0).await?;
    if !references.is_empty() {
        return Ok(DeleteAccountResponse::Conflict(Json(
            AccountDeleteConflict {
                error: "account_in_use".into(),
                reference_count: references.len() as u32,
                references,
            },
        )));
    }

    account.delete(&db).await?;
    Ok(DeleteAccountResponse::Deleted)
}

#[utoipa::path(post, path = "/accounts/{id}/reveal", operation_id = "reveal_account")]
async fn api_reveal_account(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<RevealConfirmation>,
) -> Result<RevealAccountResponse, GatedError> {
    let Some(username) = auth.username() else {
        return Ok(RevealAccountResponse::Unauthorized);
    };
    let db = gated_core::db_required(&db).await?;
    let step_up = match verify_step_up(&services, &db, username, id.0, &body).await? {
        Ok(step_up) => step_up,
        Err(StepUpFailure::BadRequest) => return Ok(RevealAccountResponse::BadRequest),
        Err(StepUpFailure::Unauthorized) => return Ok(RevealAccountResponse::Unauthorized),
        Err(StepUpFailure::RateLimited) => return Ok(RevealAccountResponse::RateLimited),
    };
    let Some(account) = Account::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(RevealAccountResponse::NotFound);
    };
    let credentials = match stored_credentials(&account) {
        Ok(credentials) => credentials,
        Err(message) => return Ok(RevealAccountResponse::UnprocessableEntity(Json(message))),
    };

    insert_account_audit_log(
        &db,
        &account,
        &step_up,
        "account.credentials.reveal",
        "Admin account credentials revealed",
    )
    .await?;

    Ok(RevealAccountResponse::Ok(
        Json(AccountReveal { credentials }),
        "no-store".into(),
    ))
}

#[utoipa::path(
    get,
    path = "/accounts/{id}/references",
    operation_id = "get_account_references"
)]
async fn api_get_account_references(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<AccountReferencesResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let exists = Account::Entity::find_by_id(id.0).one(&db).await?;
    if exists.is_none() {
        return Ok(AccountReferencesResponse::NotFound);
    }
    Ok(AccountReferencesResponse::Ok(Json(
        account_references(&db, id.0).await?,
    )))
}

async fn insert_account(
    db: &impl ConnectionTrait,
    name: String,
    description: Option<String>,
    credentials: AccountCredentials,
    tags: Option<Vec<String>>,
    created_by: Option<Uuid>,
) -> Result<Account::Model, GatedError> {
    let now = Utc::now();
    let values = Account::ActiveModel {
        kind: Set(credentials.kind().to_owned()),
        name: Set(name),
        description: Set(description),
        credentials: Set(serde_json::to_string(&credentials).map_err(GatedError::from)?),
        tags: Set(serialize_tags(tags).map_err(GatedError::from)?),
        created_by: Set(created_by),
        created_at: Set(now),
        updated_at: Set(now),
        last_used_at: Set(None),
        rotation_due_at: Set(None),
        ..Default::default()
    };
    Ok(values.insert(db).await?)
}

async fn account_summary(
    db: &impl ConnectionTrait,
    account: Account::Model,
) -> Result<AccountSummary, GatedError> {
    let reference_count = TargetAccount::Entity::find()
        .filter(TargetAccount::Column::AccountId.eq(account.id))
        .count(db)
        .await?;

    Ok(AccountSummary {
        id: account.id,
        kind: account.kind,
        name: account.name,
        description: account.description,
        tags: parse_tags(account.tags).map_err(GatedError::from)?,
        created_by: account.created_by,
        created_at: account.created_at,
        updated_at: account.updated_at,
        last_used_at: account.last_used_at,
        rotation_due_at: account.rotation_due_at,
        reference_count: reference_count.min(u64::from(u32::MAX)) as u32,
    })
}

async fn account_references(
    db: &impl ConnectionTrait,
    account_id: i32,
) -> Result<Vec<AccountReference>, GatedError> {
    let rows = TargetAccount::Entity::find()
        .filter(TargetAccount::Column::AccountId.eq(account_id))
        .find_also_related(Target::Entity)
        .all(db)
        .await?;

    let references = rows
        .into_iter()
        .filter_map(|(link, target)| {
            let target = target?;
            Some(AccountReference {
                target_id: target.id,
                target_name: target.name,
                target_kind: target_kind(&target.kind).to_owned(),
                role: link.role,
            })
        })
        .collect();

    Ok(references)
}

fn parse_credentials_for_kind(
    kind: &str,
    credentials: Value,
) -> Result<AccountCredentials, String> {
    let mut credentials = match credentials {
        Value::Object(map) => map,
        _ => return Err("credentials must be a JSON object".into()),
    };

    match credentials.get("kind").and_then(Value::as_str) {
        Some(existing_kind) if existing_kind != kind => {
            return Err(format!(
                "credentials kind {existing_kind:?} does not match account kind {kind:?}"
            ));
        }
        Some(_) => {}
        None => {
            credentials.insert("kind".into(), Value::String(kind.to_owned()));
        }
    }

    let value = Value::Object(credentials);
    let parsed = serde_json::from_value::<AccountCredentials>(value)
        .map_err(|err| format!("invalid credentials for kind {kind:?}: {err}"))?;

    if parsed.kind() == kind {
        Ok(parsed)
    } else {
        Err(format!(
            "credentials kind {:?} does not match account kind {kind:?}",
            parsed.kind()
        ))
    }
}

fn stored_credentials(account: &Account::Model) -> Result<AccountCredentials, String> {
    let parsed = serde_json::from_str::<AccountCredentials>(&account.credentials)
        .map_err(|err| format!("stored credentials are invalid: {err}"))?;
    if parsed.kind() == account.kind {
        Ok(parsed)
    } else {
        Err(format!(
            "stored credentials kind {:?} does not match account kind {:?}",
            parsed.kind(),
            account.kind
        ))
    }
}

/// A verified step-up confirmation, recorded in the audit log.
struct StepUp {
    username: String,
    reason: String,
    factor: &'static str,
}

enum StepUpFailure {
    BadRequest,
    Unauthorized,
    RateLimited,
}

/// Browser sessions must re-confirm their identity before writing account
/// credentials. API tokens are exempt: the token is itself the credential
/// and automation cannot answer an interactive challenge.
async fn require_step_up(
    auth: &RequestAuthorization,
    services: &Services,
    db: &impl ConnectionTrait,
    account_id: i32,
    confirmation: Option<&RevealConfirmation>,
) -> Result<Result<Option<StepUp>, StepUpFailure>, GatedError> {
    let RequestAuthorization::Session(session) = auth else {
        return Ok(Ok(None));
    };
    let Some(confirmation) = confirmation else {
        return Ok(Err(StepUpFailure::BadRequest));
    };
    Ok(
        verify_step_up(services, db, session.username(), account_id, confirmation)
            .await?
            .map(Some),
    )
}

/// Check a password/OTP confirmation with per-actor throttling and OTP
/// single-use. `account_id` scopes the per-account limit (0 for creates).
async fn verify_step_up(
    services: &Services,
    db: &impl ConnectionTrait,
    username: &str,
    account_id: i32,
    body: &RevealConfirmation,
) -> Result<Result<StepUp, StepUpFailure>, GatedError> {
    let Some(credential) = body.credential() else {
        return Ok(Err(StepUpFailure::BadRequest));
    };
    {
        let mut guard = REVEAL_GUARD.lock().await;
        let now = Instant::now();
        if !guard.allow(username, account_id, now) {
            return Ok(Err(StepUpFailure::RateLimited));
        }
        if body.otp.is_some() && !guard.otp_available(username, now) {
            return Ok(Err(StepUpFailure::Unauthorized));
        }
    }
    if !services
        .config_provider
        .lock()
        .await
        .validate_credential(username, &credential)
        .await?
    {
        return Ok(Err(StepUpFailure::Unauthorized));
    }
    if body.otp.is_some() {
        // Durable check so an OTP confirmation cannot be replayed across
        // a restart, which clears the in-memory guard.
        let recent = ManagementAudit::Entity::find()
            .filter(ManagementAudit::Column::Username.eq(username))
            .filter(
                ManagementAudit::Column::Timestamp.gt(Utc::now() - chrono::Duration::seconds(120)),
            )
            .all(db)
            .await?;
        if recent
            .iter()
            .any(|entry| entry.values.get("confirmation").and_then(Value::as_str) == Some("otp"))
        {
            return Ok(Err(StepUpFailure::Unauthorized));
        }
        if !REVEAL_GUARD
            .lock()
            .await
            .try_consume_otp(username, Instant::now())
        {
            return Ok(Err(StepUpFailure::Unauthorized));
        }
    }
    Ok(Ok(StepUp {
        username: username.to_owned(),
        reason: body.reason.as_deref().unwrap_or_default().trim().to_owned(),
        factor: if body.otp.is_some() {
            "otp"
        } else {
            "password"
        },
    }))
}

/// Overlay an update onto the stored credentials: an empty secret keeps the
/// stored value. Non-secret fields are taken from the update as-is.
fn merge_credentials(
    stored: &AccountCredentials,
    incoming: AccountCredentials,
) -> AccountCredentials {
    fn keep(new: String, old: &str) -> String {
        if new.is_empty() { old.to_owned() } else { new }
    }
    fn keep_opt(new: Option<String>, old: &Option<String>) -> Option<String> {
        match new {
            Some(value) if !value.is_empty() => Some(value),
            _ => old.clone(),
        }
    }
    match (stored, incoming) {
        (AccountCredentials::SshPassword(old), AccountCredentials::SshPassword(mut new)) => {
            new.password = keep(new.password, &old.password);
            AccountCredentials::SshPassword(new)
        }
        (AccountCredentials::SshKey(old), AccountCredentials::SshKey(mut new)) => {
            new.private_key_pem = keep(new.private_key_pem, &old.private_key_pem);
            new.passphrase = keep_opt(new.passphrase, &old.passphrase);
            AccountCredentials::SshKey(new)
        }
        (AccountCredentials::DbPassword(old), AccountCredentials::DbPassword(mut new)) => {
            new.password = keep(new.password, &old.password);
            AccountCredentials::DbPassword(new)
        }
        (AccountCredentials::K8sToken(old), AccountCredentials::K8sToken(mut new)) => {
            new.token = keep(new.token, &old.token);
            AccountCredentials::K8sToken(new)
        }
        (AccountCredentials::K8sClientCert(old), AccountCredentials::K8sClientCert(mut new)) => {
            new.client_private_key_pem =
                keep(new.client_private_key_pem, &old.client_private_key_pem);
            new.passphrase = keep_opt(new.passphrase, &old.passphrase);
            AccountCredentials::K8sClientCert(new)
        }
        (AccountCredentials::HttpHeaders(old), AccountCredentials::HttpHeaders(mut new)) => {
            for header in &mut new.headers {
                if header.value.is_empty()
                    && let Some(previous) = old
                        .headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case(&header.name))
                {
                    header.value = previous.value.clone();
                }
            }
            AccountCredentials::HttpHeaders(new)
        }
        (_, incoming) => incoming,
    }
}

fn validate_required_credentials(credentials: &AccountCredentials) -> Result<(), String> {
    fn require(value: &str, field: &str) -> Result<(), String> {
        if value.trim().is_empty() {
            Err(format!("{field} is required"))
        } else {
            Ok(())
        }
    }
    match credentials {
        AccountCredentials::SshPassword(c) => {
            require(&c.username, "username")?;
            require(&c.password, "password")
        }
        AccountCredentials::SshKey(c) => {
            require(&c.username, "username")?;
            require(&c.private_key_pem, "private_key_pem")
        }
        AccountCredentials::DbPassword(c) => {
            require(&c.username, "username")?;
            require(&c.password, "password")
        }
        AccountCredentials::K8sToken(c) => require(&c.token, "token"),
        AccountCredentials::K8sClientCert(c) => {
            require(&c.client_certificate_pem, "client_certificate_pem")?;
            require(&c.client_private_key_pem, "client_private_key_pem")
        }
        AccountCredentials::HttpHeaders(c) => {
            if c.headers.is_empty() {
                return Err("at least one header is required".into());
            }
            for header in &c.headers {
                require(&header.name, "header name")?;
                require(&header.value, "header value")?;
            }
            Ok(())
        }
    }
}

/// Stored credentials minus every secret value.
fn credentials_public(credentials: &AccountCredentials) -> Value {
    if let AccountCredentials::HttpHeaders(c) = credentials {
        let headers: Vec<Value> = c
            .headers
            .iter()
            .map(|h| {
                let sensitive = h.sensitive.unwrap_or(false);
                if sensitive {
                    json!({ "name": h.name, "sensitive": sensitive })
                } else {
                    json!({ "name": h.name, "sensitive": sensitive, "value": h.value })
                }
            })
            .collect();
        return json!({ "kind": credentials.kind(), "headers": headers });
    }
    let Ok(Value::Object(mut object)) = serde_json::to_value(credentials) else {
        return json!({ "kind": credentials.kind() });
    };
    object.retain(|key, _| key == "kind" || !is_sensitive_field(key));
    Value::Object(object)
}

fn credentials_schema(credentials: &AccountCredentials) -> Value {
    let value = serde_json::to_value(credentials).unwrap_or_else(|_| json!({}));
    let Value::Object(object) = value else {
        return json!({});
    };

    let mut fields = Map::new();
    for (key, value) in object {
        if key == "kind" {
            continue;
        }
        fields.insert(
            key.clone(),
            json!({
                "present": !value.is_null(),
                "sensitive": is_sensitive_field(&key),
            }),
        );
    }

    json!({
        "kind": credentials.kind(),
        "fields": fields,
    })
}

fn is_sensitive_field(field: &str) -> bool {
    matches!(
        field,
        "password"
            | "private_key_pem"
            | "passphrase"
            | "token"
            | "client_private_key_pem"
            | "value"
            | "headers"
    )
}

fn serialize_tags(tags: Option<Vec<String>>) -> serde_json::Result<Option<String>> {
    tags.map(|tags| serde_json::to_string(&tags)).transpose()
}

fn parse_tags(tags: Option<String>) -> serde_json::Result<Option<Vec<String>>> {
    tags.map(|tags| serde_json::from_str(&tags)).transpose()
}

async fn insert_account_audit_log(
    db: &impl ConnectionTrait,
    account: &Account::Model,
    step_up: &StepUp,
    event: &str,
    text: &str,
) -> Result<(), GatedError> {
    // The `confirmation` field doubles as the durable OTP single-use record
    // checked by `verify_step_up`.
    let values: JsonValue = json!({
        "event": event,
        "account_id": account.id,
        "account_name": account.name,
        "account_kind": account.kind,
        "confirmation": step_up.factor,
        "reason": step_up.reason,
        "actor": step_up.username,
    });

    let entry = ManagementAudit::ActiveModel {
        id: Set(Uuid::new_v4()),
        text: Set(text.into()),
        values: Set(values),
        timestamp: Set(Utc::now()),
        session_id: Set(Uuid::nil()),
        username: Set(Some(step_up.username.clone())),
    };
    entry.insert(db).await?;
    Ok(())
}

fn target_kind(kind: &gated_db_entities::Target::TargetKind) -> &'static str {
    match kind {
        gated_db_entities::Target::TargetKind::Http => "http",
        gated_db_entities::Target::TargetKind::MySql => "mysql",
        gated_db_entities::Target::TargetKind::Ssh => "ssh",
        gated_db_entities::Target::TargetKind::Postgres => "postgres",
    }
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_all_accounts,
        api_create_account,
        api_get_account,
        api_update_account,
        api_delete_account,
        api_reveal_account,
        api_get_account_references,
    )
}

#[cfg(test)]
mod tests {
    use gated_common::DbPasswordEngine;
    use sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, EntityTrait, Statement,
        TransactionTrait,
    };

    use super::*;

    #[test]
    fn validates_credentials_against_kind() {
        let credentials = parse_credentials_for_kind(
            "db-password",
            json!({
                "engine": "mysql",
                "username": "app",
                "password": "secret"
            }),
        )
        .expect("db-password credentials should parse");

        assert_eq!(credentials.kind(), "db-password");
        assert_eq!(
            credentials,
            AccountCredentials::DbPassword(gated_common::DbPasswordAccountCredentials {
                engine: DbPasswordEngine::Mysql,
                username: "app".into(),
                password: "secret".into(),
            })
        );

        let err = parse_credentials_for_kind(
            "ssh-password",
            json!({
                "username": "root"
            }),
        )
        .expect_err("missing password should fail");
        assert!(err.contains("invalid credentials"));
    }

    #[test]
    fn credentials_schema_does_not_include_secret_values() {
        let credentials = parse_credentials_for_kind(
            "ssh-password",
            json!({
                "username": "root",
                "password": "very-secret"
            }),
        )
        .expect("ssh-password credentials should parse");

        let schema = credentials_schema(&credentials);
        let schema_text = schema.to_string();
        assert!(schema_text.contains("password"));
        assert!(!schema_text.contains("very-secret"));
    }

    #[test]
    fn merge_keeps_stored_secrets_when_update_leaves_them_blank() {
        let stored = parse_credentials_for_kind(
            "ssh-key",
            json!({"username": "root", "private_key_pem": "KEY", "passphrase": "pp"}),
        )
        .expect("stored");
        let incoming = parse_credentials_for_kind(
            "ssh-key",
            json!({"username": "deploy", "private_key_pem": ""}),
        )
        .expect("incoming");
        assert_eq!(
            merge_credentials(&stored, incoming),
            AccountCredentials::SshKey(gated_common::SshKeyAccountCredentials {
                username: "deploy".into(),
                private_key_pem: "KEY".into(),
                passphrase: Some("pp".into()),
            })
        );

        let rotated = parse_credentials_for_kind(
            "ssh-password",
            json!({"username": "root", "password": "new"}),
        )
        .expect("rotated");
        let old = parse_credentials_for_kind(
            "ssh-password",
            json!({"username": "root", "password": "old"}),
        )
        .expect("old");
        assert_eq!(merge_credentials(&old, rotated.clone()), rotated);
    }

    #[test]
    fn merge_keeps_header_values_by_name() {
        let stored = parse_credentials_for_kind(
            "http-headers",
            json!({"headers": [{"name": "Authorization", "value": "Bearer x", "sensitive": true}]}),
        )
        .expect("stored");
        let incoming = parse_credentials_for_kind(
            "http-headers",
            json!({"headers": [
                {"name": "authorization", "value": "", "sensitive": true},
                {"name": "X-Env", "value": "prod"}
            ]}),
        )
        .expect("incoming");
        let AccountCredentials::HttpHeaders(merged) = merge_credentials(&stored, incoming) else {
            panic!("kind changed");
        };
        assert_eq!(merged.headers[0].value, "Bearer x");
        assert_eq!(merged.headers[1].value, "prod");
    }

    #[test]
    fn required_credentials_reject_blank_secrets() {
        let blank =
            parse_credentials_for_kind("ssh-password", json!({"username": "root", "password": ""}))
                .expect("parse");
        assert_eq!(
            validate_required_credentials(&blank),
            Err("password is required".into())
        );
        let no_headers =
            parse_credentials_for_kind("http-headers", json!({"headers": []})).expect("parse");
        assert!(validate_required_credentials(&no_headers).is_err());
        let ok = parse_credentials_for_kind("k8s-token", json!({"token": "t"})).expect("parse");
        assert!(validate_required_credentials(&ok).is_ok());
    }

    #[test]
    fn public_credentials_drop_secret_values() {
        let db = parse_credentials_for_kind(
            "db-password",
            json!({"engine": "postgres", "username": "app", "password": "very-secret"}),
        )
        .expect("parse");
        let public = credentials_public(&db);
        assert_eq!(
            public,
            json!({"kind": "db-password", "engine": "postgres", "username": "app"})
        );

        let headers = parse_credentials_for_kind(
            "http-headers",
            json!({"headers": [
                {"name": "Authorization", "value": "very-secret", "sensitive": true},
                {"name": "X-Env", "value": "prod"}
            ]}),
        )
        .expect("parse");
        let public = credentials_public(&headers);
        assert!(!public.to_string().contains("very-secret"));
        assert_eq!(public["headers"][1]["value"], "prod");
    }

    #[tokio::test]
    async fn create_reference_delete_and_reveal_flow() {
        let db = setup_db().await;
        let txn = db.begin().await.expect("begin transaction");
        let account = insert_account(
            &txn,
            "prod mysql readonly".into(),
            Some("Readonly DB account".into()),
            parse_credentials_for_kind(
                "db-password",
                json!({
                    "engine": "mysql",
                    "username": "readonly",
                    "password": "secret"
                }),
            )
            .expect("credentials parse"),
            Some(vec!["prod".into(), "mysql".into()]),
            None,
        )
        .await
        .expect("insert account");

        let summary = account_summary(&txn, account.clone())
            .await
            .expect("summary");
        assert_eq!(summary.reference_count, 0);
        assert_eq!(summary.tags, Some(vec!["prod".into(), "mysql".into()]));

        let target_id = Uuid::new_v4();
        Target::ActiveModel {
            id: Set(target_id),
            name: Set("prod mysql".into()),
            description: Set(String::new()),
            kind: Set(gated_db_entities::Target::TargetKind::MySql),
            options: Set(json!({"kind": "MySql"})),
            rate_limit_bytes_per_second: Set(None),
            group_id: Set(None),
        }
        .insert(&txn)
        .await
        .expect("insert target");
        TargetAccount::ActiveModel {
            target_id: Set(target_id),
            account_id: Set(account.id),
            role: Set("primary".into()),
        }
        .insert(&txn)
        .await
        .expect("insert target account");

        let references = account_references(&txn, account.id)
            .await
            .expect("references");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].target_kind, "mysql");

        insert_account_audit_log(
            &txn,
            &account,
            &StepUp {
                username: "operator".into(),
                reason: "maintenance".into(),
                factor: "password",
            },
            "account.credentials.reveal",
            "Admin account credentials revealed",
        )
        .await
        .expect("audit log insert");
        let log_count = ManagementAudit::Entity::find()
            .count(&txn)
            .await
            .expect("count logs");
        assert_eq!(log_count, 1);
    }

    async fn setup_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        for sql in [
            r#"CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                credentials TEXT NOT NULL,
                tags TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_used_at TEXT,
                rotation_due_at TEXT
            )"#,
            r#"CREATE TABLE targets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                kind TEXT NOT NULL,
                options TEXT NOT NULL,
                rate_limit_bytes_per_second INTEGER,
                group_id TEXT
            )"#,
            r#"CREATE TABLE target_accounts (
                target_id TEXT NOT NULL,
                account_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                PRIMARY KEY (target_id, account_id, role)
            )"#,
            r#"CREATE TABLE management_audit (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                "values" TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                session_id TEXT NOT NULL,
                username TEXT
            )"#,
        ] {
            db.execute(Statement::from_string(DbBackend::Sqlite, sql))
                .await
                .expect("create table");
        }
        db
    }
}
