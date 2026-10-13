use gated_common::{
    GatedError, Role as RoleConfig, SSHTargetAuth, Secret, SshTargetPasswordAuth,
    SshTargetPublicKeyAuth, Target as TargetConfig, TargetAccountMetadata, TargetAccountRole,
    TargetHttpOptions, TargetMySqlOptions, TargetOptions, TargetPostgresOptions, TargetSSHOptions,
    UpstreamAuth,
};
use gated_core::Services;
use gated_core::SharedDatabaseConnection;
use gated_db_entities::Target::TargetKind;
use gated_db_entities::{Account, KnownHost, Role, Target, TargetAccount, TargetRoleAssignment};
use poem::web::Data;
use poem_openapi::param::{Path, Query};
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, ModelTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Object)]
struct TargetDataRequest {
    name: String,
    description: Option<String>,
    options: TargetOptions,
    accounts: Option<Vec<TargetAccountBinding>>,
    rate_limit_bytes_per_second: Option<u32>,
    group_id: Option<Uuid>,
}

#[derive(Object)]
struct TargetAccountBinding {
    account_id: i32,
    role: TargetAccountRole,
}

#[derive(ApiResponse)]
enum GetTargetsResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<TargetConfig>>),
}

#[allow(clippy::large_enum_variant)]
#[derive(ApiResponse)]
enum CreateTargetResponse {
    #[oai(status = 201)]
    Created(Json<TargetConfig>),

    #[oai(status = 409)]
    Conflict(Json<String>),

    #[oai(status = 400)]
    BadRequest(Json<String>),

    #[oai(status = 422)]
    UnprocessableEntity(Json<String>),
}

pub struct ListApi;

#[OpenApi]
impl ListApi {
    #[oai(path = "/targets", method = "get", operation_id = "get_targets")]
    async fn api_get_all_targets(
        &self,
        db: Data<&SharedDatabaseConnection>,
        search: Query<Option<String>>,
        group_id: Query<Option<Uuid>>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetTargetsResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let mut targets = Target::Entity::find().order_by_asc(Target::Column::Name);

        if let Some(ref search) = *search {
            let search = format!("%{search}%");
            targets = targets.filter(Target::Column::Name.like(search));
        }

        if let Some(group_id) = *group_id {
            targets = targets.filter(Target::Column::GroupId.eq(group_id));
        }

        let rows = targets
            .find_with_related(Role::Entity)
            .all(&db)
            .await
            .map_err(GatedError::from)?;

        let mut targets = Vec::with_capacity(rows.len());
        for (target, roles) in rows {
            let mut dto = target_config_with_accounts(&db, target).await?;
            dto.allow_roles = roles.into_iter().map(|r| r.id.to_string()).collect();
            targets.push(dto);
        }

        Ok(GetTargetsResponse::Ok(Json(targets)))
    }

    #[oai(path = "/targets", method = "post", operation_id = "create_target")]
    async fn api_create_target(
        &self,
        db: Data<&SharedDatabaseConnection>,
        body: Json<TargetDataRequest>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<CreateTargetResponse, GatedError> {
        if body.name.is_empty() {
            return Ok(CreateTargetResponse::BadRequest(Json("name".into())));
        }

        let mut options = body.options.clone();
        // An empty `accounts` list switches the target to inline credentials
        // and drops existing bindings.
        let bound_accounts = body
            .accounts
            .as_deref()
            .filter(|accounts| !accounts.is_empty());
        let accounts_mode = bound_accounts.is_some();
        if accounts_mode && has_inline_credentials(&options) {
            return Ok(CreateTargetResponse::UnprocessableEntity(Json(
                "accounts cannot be mixed with inline credentials".into(),
            )));
        }
        if accounts_mode {
            clear_inline_credentials(&mut options);
        }

        let db = gated_core::db_required(&db).await?;
        let existing = Target::Entity::find()
            .filter(Target::Column::Name.eq(body.name.clone()))
            .one(&db)
            .await?;
        if existing.is_some() {
            return Ok(CreateTargetResponse::Conflict(Json(
                "Name already exists".into(),
            )));
        }
        if let Some(accounts) = bound_accounts
            && let Err(error) = validate_target_accounts(&db, &options, accounts).await
        {
            return Ok(CreateTargetResponse::UnprocessableEntity(Json(error)));
        }

        let txn = db.begin().await?;
        let values = Target::ActiveModel {
            id: Set(Uuid::new_v4()),
            name: Set(body.name.clone()),
            description: Set(body.description.clone().unwrap_or_default()),
            kind: Set((&options).into()),
            options: Set(serde_json::to_value(options).map_err(GatedError::from)?),
            rate_limit_bytes_per_second: Set(body.rate_limit_bytes_per_second.map(|x| x as i64)),
            group_id: Set(body.group_id),
        };

        let target = match values.insert(&txn).await {
            Ok(target) => target,
            Err(error)
                if matches!(
                    error.sql_err(),
                    Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
                ) =>
            {
                return Ok(CreateTargetResponse::Conflict(Json(
                    "Target name already exists".into(),
                )));
            }
            Err(error) => return Err(error.into()),
        };
        if let Some(accounts) = &body.accounts {
            replace_target_accounts(&txn, target.id, accounts).await?;
        }
        txn.commit().await?;

        Ok(CreateTargetResponse::Created(Json(
            target_config_with_accounts(&db, target).await?,
        )))
    }
}

#[allow(clippy::large_enum_variant)]
#[derive(ApiResponse)]
enum GetTargetResponse {
    #[oai(status = 200)]
    Ok(Json<TargetConfig>),
    #[oai(status = 404)]
    NotFound,
}

#[allow(clippy::large_enum_variant)]
#[derive(ApiResponse)]
enum UpdateTargetResponse {
    #[oai(status = 200)]
    Ok(Json<TargetConfig>),
    #[oai(status = 400)]
    BadRequest,
    #[oai(status = 422)]
    UnprocessableEntity(Json<String>),
    #[oai(status = 404)]
    NotFound,
}

#[derive(ApiResponse)]
enum DeleteTargetResponse {
    #[oai(status = 204)]
    Deleted,

    #[oai(status = 404)]
    NotFound,
}

#[derive(ApiResponse)]
enum TargetKnownSshHostKeysResponse {
    #[oai(status = 200)]
    Found(Json<Vec<KnownHost::Model>>),

    #[oai(status = 400)]
    InvalidType,

    #[oai(status = 404)]
    NotFound,
}

pub struct DetailApi;

#[OpenApi]
impl DetailApi {
    #[oai(path = "/targets/:id", method = "get", operation_id = "get_target")]
    async fn api_get_target(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetTargetResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let Some(target) = Target::Entity::find_by_id(id.0).one(&db).await? else {
            return Ok(GetTargetResponse::NotFound);
        };

        Ok(GetTargetResponse::Ok(Json(
            target_config_with_accounts(&db, target).await?,
        )))
    }

    #[oai(path = "/targets/:id", method = "put", operation_id = "update_target")]
    async fn api_update_target(
        &self,
        services: Data<&Services>,
        body: Json<TargetDataRequest>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<UpdateTargetResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(target) = Target::Entity::find_by_id(id.0).one(&db).await? else {
            return Ok(UpdateTargetResponse::NotFound);
        };

        if target.kind != (&body.options).into() {
            return Ok(UpdateTargetResponse::BadRequest);
        }
        if body.name.is_empty() {
            return Ok(UpdateTargetResponse::BadRequest);
        }
        // Targets are resolved by name everywhere (authorization, tickets,
        // terminals); a rename onto an existing name must be refused.
        let name_taken = Target::Entity::find()
            .filter(Target::Column::Name.eq(body.name.clone()))
            .filter(Target::Column::Id.ne(id.0))
            .one(&db)
            .await?
            .is_some();
        if name_taken {
            return Ok(UpdateTargetResponse::UnprocessableEntity(Json(
                "Name already exists".into(),
            )));
        }

        let mut options = body.options.clone();
        // An empty `accounts` list switches the target to inline credentials
        // and drops existing bindings.
        let bound_accounts = body
            .accounts
            .as_deref()
            .filter(|accounts| !accounts.is_empty());
        let accounts_mode = bound_accounts.is_some();
        if accounts_mode && has_inline_credentials(&options) {
            return Ok(UpdateTargetResponse::UnprocessableEntity(Json(
                "accounts cannot be mixed with inline credentials".into(),
            )));
        }
        if accounts_mode {
            clear_inline_credentials(&mut options);
        } else if let Ok(stored) = serde_json::from_value::<TargetOptions>(target.options.clone()) {
            keep_stored_secrets(&mut options, &stored);
        }
        if let Some(accounts) = bound_accounts
            && let Err(error) = validate_target_accounts(&db, &options, accounts).await
        {
            return Ok(UpdateTargetResponse::UnprocessableEntity(Json(error)));
        }

        let txn = db.begin().await?;
        let mut model: Target::ActiveModel = target.into();
        model.name = Set(body.name.clone());
        model.description = Set(body.description.clone().unwrap_or_default());
        model.options = Set(serde_json::to_value(options).map_err(GatedError::from)?);
        model.rate_limit_bytes_per_second = Set(body.rate_limit_bytes_per_second.map(|x| x as i64));
        model.group_id = Set(body.group_id);
        let target = match model.update(&txn).await {
            Ok(target) => target,
            Err(error)
                if matches!(
                    error.sql_err(),
                    Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
                ) =>
            {
                return Ok(UpdateTargetResponse::BadRequest);
            }
            Err(error) => return Err(error.into()),
        };
        if let Some(accounts) = &body.accounts {
            replace_target_accounts(&txn, target.id, accounts).await?;
        }
        txn.commit().await?;
        let target_id = target.id;

        drop(db);

        services
            .rate_limiter_registry
            .lock()
            .await
            .apply_new_rate_limits(&mut *services.state.write().await)
            .await?;
        services.db_pool_registry.invalidate(target_id).await;

        let db = services.db_required().await?;
        Ok(UpdateTargetResponse::Ok(Json(
            target_config_with_accounts(&db, target).await?,
        )))
    }

    #[oai(
        path = "/targets/:id",
        method = "delete",
        operation_id = "delete_target"
    )]
    async fn api_delete_target(
        &self,
        services: Data<&Services>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<DeleteTargetResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(target) = Target::Entity::find_by_id(id.0).one(&db).await? else {
            return Ok(DeleteTargetResponse::NotFound);
        };

        TargetRoleAssignment::Entity::delete_many()
            .filter(TargetRoleAssignment::Column::TargetId.eq(target.id))
            .exec(&db)
            .await?;

        if target.kind == TargetKind::Ssh {
            let options: TargetOptions = serde_json::from_value(target.options.clone())?;
            if let TargetOptions::Ssh(ssh_options) = options {
                // `known_hosts` is keyed by host:port, not by target. Only
                // drop the trusted key when no other SSH target still points
                // at the same endpoint, otherwise the sibling loses its host
                // key and is refused under `auto_reject`.
                let still_referenced = ssh_endpoint_still_referenced(
                    &db,
                    target.id,
                    &ssh_options.host,
                    ssh_options.port,
                )
                .await?;
                if !still_referenced {
                    KnownHost::Entity::delete_many()
                        .filter(KnownHost::Column::Host.eq(&ssh_options.host))
                        .filter(KnownHost::Column::Port.eq(ssh_options.port as i32))
                        .exec(&db)
                        .await?;
                }
            }
        }

        let target_id = target.id;
        target.delete(&db).await?;
        drop(db);
        services.db_pool_registry.invalidate(target_id).await;
        services.notify_authorization_changed();
        Ok(DeleteTargetResponse::Deleted)
    }

    #[oai(
        path = "/targets/:id/known-ssh-host-keys",
        method = "get",
        operation_id = "get_ssh_target_known_ssh_host_keys"
    )]
    async fn get_ssh_target_known_ssh_host_keys(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<TargetKnownSshHostKeysResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let Some(target) = Target::Entity::find_by_id(id.0).one(&db).await? else {
            return Ok(TargetKnownSshHostKeysResponse::NotFound);
        };

        let target: TargetConfig = target.try_into()?;

        let options: TargetSSHOptions = match target.options {
            TargetOptions::Ssh(x) => x,
            _ => return Ok(TargetKnownSshHostKeysResponse::InvalidType),
        };

        let known_hosts = KnownHost::Entity::find()
            .filter(
                KnownHost::Column::Host
                    .eq(&options.host)
                    .and(KnownHost::Column::Port.eq(options.port)),
            )
            .all(&db)
            .await?;

        Ok(TargetKnownSshHostKeysResponse::Found(Json(known_hosts)))
    }
}

/// Whether another SSH target (not `exclude_id`) still uses `host:port`.
async fn ssh_endpoint_still_referenced<C>(
    db: &C,
    exclude_id: Uuid,
    host: &str,
    port: u16,
) -> Result<bool, GatedError>
where
    C: ConnectionTrait,
{
    let siblings = Target::Entity::find()
        .filter(Target::Column::Kind.eq(TargetKind::Ssh))
        .filter(Target::Column::Id.ne(exclude_id))
        .all(db)
        .await?;
    Ok(siblings.into_iter().any(|sibling| {
        matches!(
            serde_json::from_value::<TargetOptions>(sibling.options),
            Ok(TargetOptions::Ssh(options)) if options.host == host && options.port == port
        )
    }))
}

async fn target_config_with_accounts<C>(
    db: &C,
    target: Target::Model,
) -> Result<TargetConfig, GatedError>
where
    C: ConnectionTrait,
{
    let target_id = target.id;
    let mut dto: TargetConfig = target.try_into().map_err(GatedError::from)?;
    let rows = TargetAccount::Entity::find()
        .filter(TargetAccount::Column::TargetId.eq(target_id))
        .find_with_related(Account::Entity)
        .all(db)
        .await?;

    let mut accounts = Vec::new();
    for (binding, account_rows) in rows {
        let Some(account) = account_rows.into_iter().next() else {
            continue;
        };
        let Some(role) = parse_target_account_role(&binding.role) else {
            continue;
        };
        accounts.push(TargetAccountMetadata {
            account_id: account.id,
            account_name: account.name,
            kind: account.kind,
            role,
        });
    }
    if accounts.is_empty() {
        redact_inline_secrets(&mut dto.options);
    } else {
        clear_inline_credentials(&mut dto.options);
    }
    dto.accounts = accounts;
    Ok(dto)
}

async fn replace_target_accounts<C>(
    db: &C,
    target_id: Uuid,
    accounts: &[TargetAccountBinding],
) -> Result<(), GatedError>
where
    C: ConnectionTrait,
{
    TargetAccount::Entity::delete_many()
        .filter(TargetAccount::Column::TargetId.eq(target_id))
        .exec(db)
        .await?;

    for account in accounts {
        if Account::Entity::find_by_id(account.account_id)
            .one(db)
            .await?
            .is_none()
        {
            return Err(GatedError::Other(
                anyhow::anyhow!("account {} not found", account.account_id).into(),
            ));
        }
        TargetAccount::ActiveModel {
            target_id: Set(target_id),
            account_id: Set(account.account_id),
            role: Set(account.role.as_str().to_string()),
        }
        .insert(db)
        .await?;
    }
    Ok(())
}

async fn validate_target_accounts<C>(
    db: &C,
    options: &TargetOptions,
    accounts: &[TargetAccountBinding],
) -> Result<(), String>
where
    C: ConnectionTrait,
{
    if !accounts
        .iter()
        .any(|account| account.role == TargetAccountRole::Primary)
    {
        return Err("accounts must include a primary binding".into());
    }

    for account in accounts {
        let Some(row) = Account::Entity::find_by_id(account.account_id)
            .one(db)
            .await
            .map_err(|e| format!("query account {} failed: {e}", account.account_id))?
        else {
            return Err(format!("account {} not found", account.account_id));
        };
        if !account_kind_matches_target(&row.kind, options) {
            return Err(format!(
                "account {} kind {} is not compatible with target kind",
                account.account_id, row.kind
            ));
        }
    }
    Ok(())
}

fn account_kind_matches_target(kind: &str, options: &TargetOptions) -> bool {
    match options {
        TargetOptions::Ssh(_) => matches!(kind, "ssh-password" | "ssh-key"),
        TargetOptions::MySql(_) | TargetOptions::Postgres(_) => kind == "db-password",
        TargetOptions::Http(_) => {
            matches!(kind, "http-headers" | "k8s-token" | "k8s-client-cert")
        }
    }
}

fn parse_target_account_role(role: &str) -> Option<TargetAccountRole> {
    match role {
        "primary" => Some(TargetAccountRole::Primary),
        "fallback" => Some(TargetAccountRole::Fallback),
        "readonly" => Some(TargetAccountRole::Readonly),
        _ => None,
    }
}

fn has_inline_credentials(options: &TargetOptions) -> bool {
    match options {
        TargetOptions::Ssh(options) => match &options.auth {
            SSHTargetAuth::Password(auth) => !auth.password.expose_secret().is_empty(),
            SSHTargetAuth::PublicKey(auth) => {
                auth.private_key_pem
                    .as_ref()
                    .is_some_and(|key| !key.expose_secret().is_empty())
                    || auth
                        .passphrase
                        .as_ref()
                        .is_some_and(|passphrase| !passphrase.expose_secret().is_empty())
            }
        },
        TargetOptions::MySql(options) => options
            .password
            .as_deref()
            .is_some_and(|password| !password.is_empty()),
        TargetOptions::Postgres(options) => options
            .password
            .as_deref()
            .is_some_and(|password| !password.is_empty()),
        TargetOptions::Http(options) => match &options.upstream_auth {
            UpstreamAuth::None(_) => false,
            UpstreamAuth::Headers(auth) => !auth.headers.is_empty(),
            UpstreamAuth::BearerToken(auth) => !auth.token.expose_secret().is_empty(),
            UpstreamAuth::ClientCertificate(auth) => {
                !auth.certificate.expose_secret().is_empty()
                    || !auth.private_key.expose_secret().is_empty()
            }
        },
    }
}

fn clear_inline_credentials(options: &mut TargetOptions) {
    match options {
        TargetOptions::Ssh(TargetSSHOptions { username, auth, .. }) => {
            username.clear();
            *auth = SSHTargetAuth::default();
        }
        TargetOptions::MySql(TargetMySqlOptions {
            username, password, ..
        }) => {
            username.clear();
            *password = None;
        }
        TargetOptions::Postgres(TargetPostgresOptions {
            username, password, ..
        }) => {
            username.clear();
            *password = None;
        }
        TargetOptions::Http(TargetHttpOptions {
            ca_certificate,
            upstream_auth,
            ..
        }) => {
            *ca_certificate = None;
            *upstream_auth = UpstreamAuth::default();
        }
    }
}

/// Blank the secret fields of inline credentials for read endpoints while
/// keeping the username and the authentication method.
fn redact_inline_secrets(options: &mut TargetOptions) {
    match options {
        TargetOptions::Ssh(TargetSSHOptions { auth, .. }) => {
            *auth = match auth {
                SSHTargetAuth::Password(_) => SSHTargetAuth::Password(SshTargetPasswordAuth {
                    password: Secret::new(String::new()),
                }),
                SSHTargetAuth::PublicKey(_) => {
                    SSHTargetAuth::PublicKey(SshTargetPublicKeyAuth::default())
                }
            };
        }
        TargetOptions::MySql(TargetMySqlOptions { password, .. })
        | TargetOptions::Postgres(TargetPostgresOptions { password, .. }) => {
            *password = None;
        }
        TargetOptions::Http(TargetHttpOptions { upstream_auth, .. }) => match upstream_auth {
            UpstreamAuth::None(_) => {}
            UpstreamAuth::Headers(auth) => {
                for value in auth.headers.values_mut() {
                    *value = Secret::new(String::new());
                }
            }
            UpstreamAuth::BearerToken(auth) => auth.token = Secret::new(String::new()),
            UpstreamAuth::ClientCertificate(auth) => {
                auth.certificate = Secret::new(String::new());
                auth.private_key = Secret::new(String::new());
            }
        },
    }
}

/// On update, a blank inline secret means "keep the stored one" as long as
/// the authentication method is unchanged (read endpoints never return
/// secrets, so a read-modify-write round trip must not wipe them).
fn keep_stored_secrets(options: &mut TargetOptions, stored: &TargetOptions) {
    let blank = |secret: &Option<Secret<String>>| {
        secret
            .as_ref()
            .is_none_or(|secret| secret.expose_secret().is_empty())
    };
    match (options, stored) {
        (TargetOptions::Ssh(options), TargetOptions::Ssh(stored)) => {
            match (&mut options.auth, &stored.auth) {
                (SSHTargetAuth::Password(auth), SSHTargetAuth::Password(stored))
                    if auth.password.expose_secret().is_empty() =>
                {
                    auth.password = stored.password.clone();
                }
                (SSHTargetAuth::PublicKey(auth), SSHTargetAuth::PublicKey(stored))
                    if blank(&auth.private_key_pem) =>
                {
                    *auth = stored.clone();
                }
                _ => {}
            }
        }
        (
            TargetOptions::MySql(TargetMySqlOptions { password, .. }),
            TargetOptions::MySql(stored),
        ) if password.as_deref().is_none_or(str::is_empty) => {
            password.clone_from(&stored.password);
        }
        (
            TargetOptions::Postgres(TargetPostgresOptions { password, .. }),
            TargetOptions::Postgres(stored),
        ) if password.as_deref().is_none_or(str::is_empty) => {
            password.clone_from(&stored.password);
        }
        (TargetOptions::Http(options), TargetOptions::Http(stored)) => {
            if options.ca_certificate.is_none() {
                options.ca_certificate.clone_from(&stored.ca_certificate);
            }
            match (&mut options.upstream_auth, &stored.upstream_auth) {
                (UpstreamAuth::Headers(auth), UpstreamAuth::Headers(stored)) => {
                    for (name, value) in auth.headers.iter_mut() {
                        if value.expose_secret().is_empty()
                            && let Some(stored) = stored.headers.get(name)
                        {
                            *value = stored.clone();
                        }
                    }
                }
                (UpstreamAuth::BearerToken(auth), UpstreamAuth::BearerToken(stored))
                    if auth.token.expose_secret().is_empty() =>
                {
                    auth.token = stored.token.clone();
                }
                (
                    UpstreamAuth::ClientCertificate(auth),
                    UpstreamAuth::ClientCertificate(stored),
                ) if auth.certificate.expose_secret().is_empty()
                    && auth.private_key.expose_secret().is_empty() =>
                {
                    *auth = stored.clone();
                }
                _ => {}
            }
        }
        _ => {}
    }
}

#[derive(ApiResponse)]
enum GetTargetRolesResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<RoleConfig>>),
    #[oai(status = 404)]
    NotFound,
}

#[derive(ApiResponse)]
enum AddTargetRoleResponse {
    #[oai(status = 201)]
    Created,
    #[oai(status = 409)]
    AlreadyExists,
}

#[derive(ApiResponse)]
enum DeleteTargetRoleResponse {
    #[oai(status = 204)]
    Deleted,
    #[oai(status = 404)]
    NotFound,
}

pub struct RolesApi;

#[OpenApi]
impl RolesApi {
    #[oai(
        path = "/targets/:id/roles",
        method = "get",
        operation_id = "get_target_roles"
    )]
    async fn api_get_target_roles(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetTargetRolesResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let Some((_, roles)) = Target::Entity::find_by_id(*id)
            .find_with_related(Role::Entity)
            .all(&db)
            .await
            .map(|x| x.into_iter().next())
            .map_err(GatedError::from)?
        else {
            return Ok(GetTargetRolesResponse::NotFound);
        };

        Ok(GetTargetRolesResponse::Ok(Json(
            roles.into_iter().map(|x| x.into()).collect(),
        )))
    }

    #[oai(
        path = "/targets/:id/roles/:role_id",
        method = "post",
        operation_id = "add_target_role"
    )]
    async fn api_add_target_role(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
        role_id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<AddTargetRoleResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        if !TargetRoleAssignment::Entity::find()
            .filter(TargetRoleAssignment::Column::TargetId.eq(id.0))
            .filter(TargetRoleAssignment::Column::RoleId.eq(role_id.0))
            .all(&db)
            .await
            .map_err(GatedError::from)?
            .is_empty()
        {
            return Ok(AddTargetRoleResponse::AlreadyExists);
        }

        let values = TargetRoleAssignment::ActiveModel {
            target_id: Set(id.0),
            role_id: Set(role_id.0),
            ..Default::default()
        };

        values.insert(&db).await.map_err(GatedError::from)?;

        Ok(AddTargetRoleResponse::Created)
    }

    #[oai(
        path = "/targets/:id/roles/:role_id",
        method = "delete",
        operation_id = "delete_target_role"
    )]
    async fn api_delete_target_role(
        &self,
        db: Data<&SharedDatabaseConnection>,
        services: Data<&Services>,
        id: Path<Uuid>,
        role_id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<DeleteTargetRoleResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        if Target::Entity::find_by_id(id.0).one(&db).await?.is_none() {
            return Ok(DeleteTargetRoleResponse::NotFound);
        }

        if Role::Entity::find_by_id(role_id.0)
            .one(&db)
            .await?
            .is_none()
        {
            return Ok(DeleteTargetRoleResponse::NotFound);
        }

        let Some(model) = TargetRoleAssignment::Entity::find()
            .filter(TargetRoleAssignment::Column::TargetId.eq(id.0))
            .filter(TargetRoleAssignment::Column::RoleId.eq(role_id.0))
            .one(&db)
            .await
            .map_err(GatedError::from)?
        else {
            return Ok(DeleteTargetRoleResponse::NotFound);
        };

        model.delete(&db).await.map_err(GatedError::from)?;
        services.notify_authorization_changed();

        Ok(DeleteTargetRoleResponse::Deleted)
    }
}

#[cfg(test)]
mod tests {
    use gated_common::{
        BearerTokenUpstreamAuth, HeadersUpstreamAuth, HttpProxyFlavor, Secret,
        SshTargetPasswordAuth, SshTargetPublicKeyAuth, TargetHttpOptions, TargetMySqlOptions, Tls,
        UpstreamAuth,
    };
    use gated_tls::TlsMode;
    use sea_orm::{
        ActiveModelTrait, ConnectionTrait, Database, DatabaseConnection, DbBackend, EntityTrait,
        Set, Statement,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn account_mode_clears_credential_fields_but_keeps_location_fields() {
        let mut options = TargetOptions::MySql(TargetMySqlOptions {
            host: "db.internal".into(),
            port: 3306,
            username: "app".into(),
            password: Some("secret".into()),
            tls: Tls {
                mode: TlsMode::Preferred,
                verify: true,
            },
            default_database_name: Some("prod".into()),
            readonly: true,
        });

        assert!(has_inline_credentials(&options));
        clear_inline_credentials(&mut options);

        let TargetOptions::MySql(options) = options else {
            panic!("expected mysql options");
        };
        assert_eq!(options.host, "db.internal");
        assert_eq!(options.default_database_name.as_deref(), Some("prod"));
        assert!(options.username.is_empty());
        assert!(options.password.is_none());
    }

    #[test]
    fn inline_detection_covers_http_secrets() {
        let k8s = TargetOptions::Http(TargetHttpOptions {
            url: "https://k8s.internal".into(),
            tls: Tls::default(),
            ca_certificate: None,
            upstream_auth: UpstreamAuth::BearerToken(BearerTokenUpstreamAuth {
                token: Secret::new("token".into()),
            }),
            flavor: HttpProxyFlavor::Kubernetes,
        });
        assert!(has_inline_credentials(&k8s));

        let mut headers = std::collections::HashMap::new();
        headers.insert("authorization".into(), Secret::new("Bearer secret".into()));
        let api = TargetOptions::Http(TargetHttpOptions {
            url: "https://api.internal".into(),
            tls: Tls::default(),
            ca_certificate: None,
            upstream_auth: UpstreamAuth::Headers(HeadersUpstreamAuth { headers }),
            flavor: HttpProxyFlavor::Generic,
        });
        assert!(has_inline_credentials(&api));
    }

    #[tokio::test]
    async fn target_config_includes_account_metadata_without_credentials() {
        let db = setup_db().await;
        let target_id = Uuid::new_v4();
        Target::ActiveModel {
            id: Set(target_id),
            name: Set("prod mysql".into()),
            description: Set(String::new()),
            kind: Set(TargetKind::MySql),
            options: Set(json!({
                "mysql": {
                    "host": "db.internal",
                    "port": 3306,
                    "username": "legacy",
                    "password": "secret",
                    "tls": {"mode": "disabled", "verify": false},
                    "default_database_name": "prod",
                    "readonly": false
                }
            })),
            rate_limit_bytes_per_second: Set(None),
            group_id: Set(None),
        }
        .insert(&db)
        .await
        .expect("insert target");
        Account::ActiveModel {
            kind: Set("db-password".into()),
            name: Set("prod db".into()),
            description: Set(None),
            credentials: Set(json!({
                "kind": "db-password",
                "engine": "mysql",
                "username": "app",
                "password": "account-secret"
            })
            .to_string()),
            tags: Set(None),
            created_by: Set(None),
            created_at: Set(chrono::Utc::now()),
            updated_at: Set(chrono::Utc::now()),
            last_used_at: Set(None),
            rotation_due_at: Set(None),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("insert account");

        replace_target_accounts(
            &db,
            target_id,
            &[TargetAccountBinding {
                account_id: 1,
                role: TargetAccountRole::Primary,
            }],
        )
        .await
        .expect("replace target accounts");

        let target = Target::Entity::find_by_id(target_id)
            .one(&db)
            .await
            .expect("query target")
            .expect("target exists");
        let dto = target_config_with_accounts(&db, target)
            .await
            .expect("target dto");

        assert_eq!(dto.accounts.len(), 1);
        assert_eq!(dto.accounts[0].account_name, "prod db");
        let TargetOptions::MySql(options) = dto.options else {
            panic!("expected mysql options");
        };
        assert!(options.username.is_empty());
        assert!(options.password.is_none());
    }

    #[tokio::test]
    async fn inline_target_config_keeps_username_and_redacts_secrets() {
        let db = setup_db().await;
        let target_id = Uuid::new_v4();
        Target::ActiveModel {
            id: Set(target_id),
            name: Set("inline mysql".into()),
            description: Set(String::new()),
            kind: Set(TargetKind::MySql),
            options: Set(json!({
                "mysql": {
                    "host": "db.internal",
                    "port": 3306,
                    "username": "app",
                    "password": "secret",
                    "tls": {"mode": "disabled", "verify": false},
                    "readonly": false
                }
            })),
            rate_limit_bytes_per_second: Set(None),
            group_id: Set(None),
        }
        .insert(&db)
        .await
        .expect("insert target");

        let target = Target::Entity::find_by_id(target_id)
            .one(&db)
            .await
            .expect("query target")
            .expect("target exists");
        let dto = target_config_with_accounts(&db, target)
            .await
            .expect("target dto");

        assert!(dto.accounts.is_empty());
        let TargetOptions::MySql(options) = dto.options else {
            panic!("expected mysql options");
        };
        assert_eq!(options.username, "app");
        assert!(options.password.is_none());
    }

    #[test]
    fn blank_inline_secrets_keep_stored_values() {
        let ssh = |auth: SSHTargetAuth| {
            TargetOptions::Ssh(TargetSSHOptions {
                host: "h".into(),
                port: 22,
                username: "root".into(),
                allow_insecure_algos: None,
                auth,
            })
        };
        let password = |value: &str| {
            SSHTargetAuth::Password(SshTargetPasswordAuth {
                password: Secret::new(value.into()),
            })
        };
        let auth_of = |options: TargetOptions| match options {
            TargetOptions::Ssh(options) => options.auth,
            _ => panic!("expected ssh options"),
        };

        let mut blank = ssh(password(""));
        keep_stored_secrets(&mut blank, &ssh(password("old")));
        assert_eq!(auth_of(blank), password("old"));

        let mut changed = ssh(password("new"));
        keep_stored_secrets(&mut changed, &ssh(password("old")));
        assert_eq!(auth_of(changed), password("new"));

        let stored_key = SSHTargetAuth::PublicKey(SshTargetPublicKeyAuth {
            private_key_pem: Some(Secret::new("KEY".into())),
            passphrase: Some(Secret::new("pass".into())),
        });
        let mut blank_key = ssh(SSHTargetAuth::PublicKey(SshTargetPublicKeyAuth::default()));
        keep_stored_secrets(&mut blank_key, &ssh(stored_key.clone()));
        assert_eq!(auth_of(blank_key), stored_key);

        // Switching the method never carries the old secret over.
        let mut switched = ssh(password(""));
        keep_stored_secrets(&mut switched, &ssh(stored_key));
        assert_eq!(auth_of(switched), password(""));

        let mysql = |password: Option<&str>| {
            TargetOptions::MySql(TargetMySqlOptions {
                host: "db".into(),
                port: 3306,
                username: "app".into(),
                password: password.map(Into::into),
                tls: Tls::default(),
                default_database_name: None,
                readonly: false,
            })
        };
        let mut blank_db = mysql(None);
        keep_stored_secrets(&mut blank_db, &mysql(Some("old")));
        let TargetOptions::MySql(blank_db) = blank_db else {
            panic!("expected mysql options");
        };
        assert_eq!(blank_db.password.as_deref(), Some("old"));
    }

    async fn insert_ssh_target(db: &DatabaseConnection, name: &str, host: &str, port: u16) -> Uuid {
        let id = Uuid::new_v4();
        Target::ActiveModel {
            id: Set(id),
            name: Set(name.into()),
            description: Set(String::new()),
            kind: Set(TargetKind::Ssh),
            options: Set(json!({
                "ssh": {
                    "host": host,
                    "port": port,
                    "username": "root",
                    "allow_insecure_algos": false,
                    "auth": {"kind": "PublicKey"}
                }
            })),
            rate_limit_bytes_per_second: Set(None),
            group_id: Set(None),
        }
        .insert(db)
        .await
        .expect("insert ssh target");
        id
    }

    #[tokio::test]
    async fn known_host_is_kept_while_a_sibling_target_uses_the_endpoint() {
        let db = setup_db().await;
        let a = insert_ssh_target(&db, "a", "host.internal", 22).await;
        let _b = insert_ssh_target(&db, "b", "host.internal", 22).await;
        let c = insert_ssh_target(&db, "c", "other.internal", 22).await;

        assert!(
            ssh_endpoint_still_referenced(&db, a, "host.internal", 22)
                .await
                .expect("query")
        );
        assert!(
            !ssh_endpoint_still_referenced(&db, c, "other.internal", 22)
                .await
                .expect("query")
        );
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
        ] {
            db.execute(Statement::from_string(DbBackend::Sqlite, sql))
                .await
                .expect("create table");
        }
        db
    }
}
