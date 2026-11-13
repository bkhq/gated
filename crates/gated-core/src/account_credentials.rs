use chrono::Utc;
use gated_common::{
    AccountCredentials, BearerTokenUpstreamAuth, ClientCertificateUpstreamAuth, DbPasswordEngine,
    HeadersUpstreamAuth, SSHTargetAuth, Secret, SshTargetPasswordAuth, SshTargetPublicKeyAuth,
    Target, TargetHttpOptions, TargetOptions, TargetSSHOptions, UpstreamAuth,
};
use gated_db_entities::{Account, TargetAccount, TargetRoleAssignment, User};
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};
use serde::Serialize;
use uuid::Uuid;

/// Which upstream login a connection to a target uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TargetLogin {
    /// The target's primary account, else its inline credentials.
    Default,
    Account(i32),
}

/// One login a user may pick for a target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct LoginChoice {
    /// `None` is the target's own inline credentials.
    pub account_id: Option<i32>,
    /// Account name; `None` for the inline credentials.
    pub name: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoginSelectionError {
    /// Several accounts apply and none was chosen; carries their names.
    Ambiguous(Vec<String>),
    /// The requested account is not one the user's roles may use.
    NotAllowed(String),
    Internal(String),
}

impl std::fmt::Display for LoginSelectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ambiguous(names) => write!(
                f,
                "several accounts are available for this target, choose one of: {}",
                names.join(", ")
            ),
            Self::NotAllowed(name) => {
                write!(f, "account {name:?} is not available to you on this target")
            }
            Self::Internal(message) => f.write_str(message),
        }
    }
}

async fn primary_account_id(
    db: &DatabaseConnection,
    target_id: Uuid,
) -> Result<Option<i32>, String> {
    Ok(TargetAccount::Entity::find()
        .filter(TargetAccount::Column::TargetId.eq(target_id))
        .filter(TargetAccount::Column::Role.eq("primary"))
        .one(db)
        .await
        .map_err(|e| format!("query target account binding failed: {e}"))?
        .map(|binding| binding.account_id))
}

/// The logins `username` may use on a target: the account each of their
/// granting roles maps to, or the target's default login for unmapped roles.
/// Empty when no role grants the target.
pub async fn login_choices(
    db: &DatabaseConnection,
    target_id: Uuid,
    username: &str,
) -> Result<Vec<LoginChoice>, String> {
    let query_err = |e: sea_orm::DbErr| format!("query login choices failed: {e}");
    let Some(user) = User::Entity::find()
        .filter(User::Column::Username.eq(username))
        .one(db)
        .await
        .map_err(query_err)?
    else {
        return Ok(vec![]);
    };
    let role_ids: Vec<Uuid> = user
        .active_roles(db)
        .await
        .map_err(query_err)?
        .into_iter()
        .map(|role| role.id)
        .collect();
    let grants = TargetRoleAssignment::Entity::find()
        .filter(TargetRoleAssignment::Column::TargetId.eq(target_id))
        .filter(TargetRoleAssignment::Column::RoleId.is_in(role_ids))
        .all(db)
        .await
        .map_err(query_err)?;
    if grants.is_empty() {
        return Ok(vec![]);
    }

    let primary = primary_account_id(db, target_id).await?;
    let mut accounts: Vec<Option<i32>> = grants
        .into_iter()
        .map(|grant| grant.account_id.or(primary))
        .collect();
    accounts.sort_unstable();
    accounts.dedup();

    let mut choices = Vec::with_capacity(accounts.len());
    for account_id in accounts {
        let name = match account_id {
            Some(id) => Some(
                Account::Entity::find_by_id(id)
                    .one(db)
                    .await
                    .map_err(query_err)?
                    .ok_or_else(|| format!("account {id} not found"))?
                    .name,
            ),
            None => None,
        };
        choices.push(LoginChoice { account_id, name });
    }
    choices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(choices)
}

/// Pick the login for a connection. `requested` is an account name the user
/// chose (empty means none). With no choice, a single applicable login is
/// used; several are an error listing them.
pub async fn select_login(
    db: &DatabaseConnection,
    target_id: Uuid,
    username: &str,
    requested: Option<&str>,
) -> Result<TargetLogin, LoginSelectionError> {
    let choices = login_choices(db, target_id, username)
        .await
        .map_err(LoginSelectionError::Internal)?;
    let login = |choice: &LoginChoice| {
        if let Some(name) = &choice.name {
            tracing::info!(target: "audit", account = %name, "Target account selected");
        }
        match choice.account_id {
            Some(id) => TargetLogin::Account(id),
            None => TargetLogin::Default,
        }
    };
    let selected = match requested.filter(|name| !name.is_empty()) {
        Some(name) => choices
            .iter()
            .find(|choice| choice.name.as_deref() == Some(name))
            .map(login)
            .ok_or_else(|| LoginSelectionError::NotAllowed(name.to_string())),
        // No grant (e.g. a ticket) keeps the target's default login.
        None if choices.len() <= 1 => Ok(choices.first().map_or(TargetLogin::Default, login)),
        None => Err(LoginSelectionError::Ambiguous(
            choices
                .into_iter()
                .map(|choice| choice.name.unwrap_or_else(|| "(target login)".into()))
                .collect(),
        )),
    };
    if let Err(error @ (LoginSelectionError::Ambiguous(_) | LoginSelectionError::NotAllowed(_))) =
        &selected
    {
        tracing::warn!(target: "audit", %error, "Target account not selected");
    }
    selected
}

pub async fn primary_account_credentials(
    db: &DatabaseConnection,
    target_id: Uuid,
) -> Result<Option<(i32, AccountCredentials)>, String> {
    match primary_account_id(db, target_id).await? {
        Some(account_id) => account_credentials(db, account_id).await.map(Some),
        None => Ok(None),
    }
}

/// Credentials of the account a login uses; `None` for inline credentials.
pub async fn login_account_credentials(
    db: &DatabaseConnection,
    target_id: Uuid,
    login: TargetLogin,
) -> Result<Option<(i32, AccountCredentials)>, String> {
    match login {
        TargetLogin::Default => primary_account_credentials(db, target_id).await,
        TargetLogin::Account(account_id) => account_credentials(db, account_id).await.map(Some),
    }
}

async fn account_credentials(
    db: &DatabaseConnection,
    account_id: i32,
) -> Result<(i32, AccountCredentials), String> {
    let Some(account) = Account::Entity::find_by_id(account_id)
        .one(db)
        .await
        .map_err(|e| format!("query account failed: {e}"))?
    else {
        return Err(format!("account {account_id} not found"));
    };

    let credentials = serde_json::from_str::<AccountCredentials>(&account.credentials)
        .map_err(|e| format!("invalid account credentials for {}: {e}", account.id))?;
    if credentials.kind() != account.kind {
        return Err(format!(
            "account {} kind mismatch: row is {}, credentials are {}",
            account.id,
            account.kind,
            credentials.kind()
        ));
    }

    Ok((account.id, credentials))
}

pub async fn update_account_last_used_at(
    db: &DatabaseConnection,
    account_id: i32,
) -> Result<(), String> {
    let Some(account) = Account::Entity::find_by_id(account_id)
        .one(db)
        .await
        .map_err(|e| format!("query account failed: {e}"))?
    else {
        return Err(format!("account {account_id} not found"));
    };

    let mut model: Account::ActiveModel = account.into();
    model.last_used_at = Set(Some(Utc::now()));
    model
        .update(db)
        .await
        .map_err(|e| format!("update account last_used_at failed: {e}"))?;
    Ok(())
}

/// The login a desktop session presents to an RDP or VNC target. No `Debug`:
/// it holds the password.
#[derive(Clone)]
pub struct DesktopLogin {
    /// `None`: the target's inline credentials.
    pub account_id: Option<i32>,
    /// Empty for VNC.
    pub username: String,
    pub domain: Option<String>,
    pub password: Option<String>,
}

/// Credentials for a desktop target: the selected account, else the inline ones.
pub async fn desktop_login(
    db: &DatabaseConnection,
    target: &Target,
    login: TargetLogin,
) -> Result<DesktopLogin, String> {
    let account = login_account_credentials(db, target.id, login).await?;
    desktop_login_from(&target.options, account)
}

fn desktop_login_from(
    options: &TargetOptions,
    account: Option<(i32, AccountCredentials)>,
) -> Result<DesktopLogin, String> {
    let mut login = match options {
        TargetOptions::Rdp(options) => DesktopLogin {
            account_id: None,
            username: options.username.clone(),
            domain: options.domain.clone(),
            password: options.password.clone(),
        },
        TargetOptions::Vnc(options) => DesktopLogin {
            account_id: None,
            username: String::new(),
            domain: None,
            password: options.password.clone(),
        },
        _ => return Err("target is not RDP/VNC".into()),
    };
    if let Some((account_id, credentials)) = account {
        let AccountCredentials::DesktopPassword(credentials) = credentials else {
            return Err(format!("account {account_id} is not desktop-password"));
        };
        login.account_id = Some(account_id);
        login.password = Some(credentials.password);
        if matches!(options, TargetOptions::Rdp(_)) {
            if !credentials.username.is_empty() {
                login.username = credentials.username;
            }
            login.domain = credentials.domain;
        }
    }
    login.domain = login.domain.filter(|domain| !domain.is_empty());
    login.password = login.password.filter(|password| !password.is_empty());
    Ok(login)
}

pub async fn resolve_db_account(
    db: &DatabaseConnection,
    target: &Target,
    login: TargetLogin,
) -> Result<Option<(i32, gated_common::DbPasswordAccountCredentials)>, String> {
    let Some((account_id, credentials)) = login_account_credentials(db, target.id, login).await?
    else {
        return Ok(None);
    };
    let expected = match target.options {
        TargetOptions::MySql(_) => DbPasswordEngine::Mysql,
        TargetOptions::Postgres(_) => DbPasswordEngine::Postgres,
        _ => return Err("target is not MySQL/Postgres".into()),
    };
    let AccountCredentials::DbPassword(credentials) = credentials else {
        return Err(format!("account {account_id} is not db-password"));
    };
    if credentials.engine != expected {
        return Err(format!(
            "account {account_id} engine {:?} does not match target",
            credentials.engine
        ));
    }
    Ok(Some((account_id, credentials)))
}

pub async fn ssh_options_with_account(
    db: &DatabaseConnection,
    target: &Target,
    login: TargetLogin,
    fallback_username: Option<&str>,
) -> Result<(TargetSSHOptions, Option<i32>), String> {
    let TargetOptions::Ssh(mut options) = target.options.clone() else {
        return Err("target is not SSH".into());
    };
    let account_id = match login_account_credentials(db, target.id, login).await? {
        Some((account_id, credentials)) => {
            apply_ssh_account(&mut options, credentials)
                .map_err(|()| format!("account {account_id} is not an SSH credential"))?;
            Some(account_id)
        }
        None => None,
    };

    if options.username.is_empty()
        && let Some(username) = fallback_username
    {
        options.username = username.to_string();
    }
    Ok((options, account_id))
}

/// Override the target's SSH login with a bound account. A key account
/// without a username keeps the target's username.
fn apply_ssh_account(
    options: &mut TargetSSHOptions,
    credentials: AccountCredentials,
) -> Result<(), ()> {
    match credentials {
        AccountCredentials::SshPassword(credentials) => {
            options.username = credentials.username;
            options.auth = SSHTargetAuth::Password(SshTargetPasswordAuth {
                password: Secret::new(credentials.password),
            });
        }
        AccountCredentials::SshKey(credentials) => {
            if !credentials.username.is_empty() {
                options.username = credentials.username;
            }
            options.auth = SSHTargetAuth::PublicKey(SshTargetPublicKeyAuth {
                private_key_pem: Some(Secret::new(credentials.private_key_pem)),
                passphrase: credentials.passphrase.map(Secret::new),
            });
        }
        _ => return Err(()),
    }
    Ok(())
}

/// Resolve `TargetHttpOptions` for an HTTP-flavor target, optionally
/// overriding `upstream_auth` and `ca_certificate` from a bound account.
///
/// Credential -> upstream auth mapping:
/// - `HttpHeaders` -> `UpstreamAuth::Headers`
/// - `K8sToken`     -> `UpstreamAuth::BearerToken`  (+ CA bundle if present)
/// - `K8sClientCert`-> `UpstreamAuth::ClientCertificate` (+ CA bundle if present)
pub async fn http_options_with_account(
    db: &DatabaseConnection,
    target: &Target,
) -> Result<(TargetHttpOptions, Option<i32>), String> {
    let TargetOptions::Http(mut options) = target.options.clone() else {
        return Err("target is not HTTP".into());
    };
    if let Some((account_id, credentials)) = primary_account_credentials(db, target.id).await? {
        match credentials {
            AccountCredentials::HttpHeaders(credentials) => {
                let headers = credentials
                    .headers
                    .into_iter()
                    .map(|header| (header.name, Secret::new(header.value)))
                    .collect();
                options.upstream_auth = UpstreamAuth::Headers(HeadersUpstreamAuth { headers });
                Ok((options, Some(account_id)))
            }
            AccountCredentials::K8sToken(credentials) => {
                options.ca_certificate = credentials.ca_pem.map(Secret::new);
                options.upstream_auth = UpstreamAuth::BearerToken(BearerTokenUpstreamAuth {
                    token: Secret::new(credentials.token),
                });
                Ok((options, Some(account_id)))
            }
            AccountCredentials::K8sClientCert(credentials) => {
                options.ca_certificate = credentials.ca_pem.map(Secret::new);
                options.upstream_auth =
                    UpstreamAuth::ClientCertificate(ClientCertificateUpstreamAuth {
                        certificate: Secret::new(credentials.client_certificate_pem),
                        private_key: Secret::new(credentials.client_private_key_pem),
                    });
                Ok((options, Some(account_id)))
            }
            _ => Err(format!(
                "account {account_id} is not an HTTP-compatible credential"
            )),
        }
    } else {
        Ok((options, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_options() -> TargetSSHOptions {
        TargetSSHOptions {
            host: "10.0.0.1".into(),
            port: 22,
            username: "deploy".into(),
            allow_insecure_algos: None,
            auth: SSHTargetAuth::default(),
        }
    }

    fn key_account(username: &str) -> AccountCredentials {
        AccountCredentials::SshKey(gated_common::SshKeyAccountCredentials {
            username: username.into(),
            private_key_pem: "PEM".into(),
            passphrase: None,
        })
    }

    fn desktop_account(username: &str, domain: Option<&str>) -> Option<(i32, AccountCredentials)> {
        Some((
            7,
            AccountCredentials::DesktopPassword(gated_common::DesktopPasswordAccountCredentials {
                username: username.into(),
                password: "account-pw".into(),
                domain: domain.map(Into::into),
            }),
        ))
    }

    fn rdp_target() -> TargetOptions {
        TargetOptions::Rdp(gated_common::TargetRdpOptions {
            host: "10.0.0.2".into(),
            port: 3389,
            username: "inline".into(),
            domain: Some("INLINE".into()),
            password: Some("inline-pw".into()),
            verify_tls: true,
            record_keystrokes: false,
        })
    }

    fn vnc_target(password: Option<&str>) -> TargetOptions {
        TargetOptions::Vnc(gated_common::TargetVncOptions {
            host: "10.0.0.3".into(),
            port: 5900,
            password: password.map(Into::into),
            record_keystrokes: false,
        })
    }

    #[test]
    fn a_desktop_account_replaces_the_inline_login() {
        let login =
            desktop_login_from(&rdp_target(), desktop_account("svc", Some("CORP"))).expect("login");
        assert_eq!(login.account_id, Some(7));
        assert_eq!(login.username, "svc");
        assert_eq!(login.domain.as_deref(), Some("CORP"));
        assert_eq!(login.password.as_deref(), Some("account-pw"));

        // The account's domain is its own: the inline one is not mixed in.
        let login = desktop_login_from(&rdp_target(), desktop_account("svc", None)).expect("login");
        assert_eq!(login.domain, None);
    }

    #[test]
    fn a_desktop_account_without_a_username_keeps_the_target_username() {
        let login = desktop_login_from(&rdp_target(), desktop_account("", None)).expect("login");
        assert_eq!(login.username, "inline");
        assert_eq!(login.password.as_deref(), Some("account-pw"));
    }

    #[test]
    fn without_an_account_the_inline_login_is_used() {
        let login = desktop_login_from(&rdp_target(), None).expect("login");
        assert_eq!(login.account_id, None);
        assert_eq!(login.username, "inline");
        assert_eq!(login.domain.as_deref(), Some("INLINE"));
        assert_eq!(login.password.as_deref(), Some("inline-pw"));

        let login = desktop_login_from(&vnc_target(None), None).expect("login");
        assert_eq!(login.password, None);
        let login = desktop_login_from(&vnc_target(Some("")), None).expect("login");
        assert_eq!(login.password, None, "a blank password is no password");
    }

    #[test]
    fn vnc_takes_only_the_password_of_an_account() {
        let login =
            desktop_login_from(&vnc_target(Some("inline-pw")), desktop_account("svc", None))
                .expect("login");
        assert_eq!(login.username, "");
        assert_eq!(login.password.as_deref(), Some("account-pw"));
    }

    #[test]
    fn a_desktop_login_needs_a_desktop_account_and_target() {
        let other = Some((3, key_account("deploy")));
        assert!(
            desktop_login_from(&rdp_target(), other).is_err_and(|e| e.contains("desktop-password"))
        );
        let ssh = TargetOptions::Ssh(target_options());
        assert!(desktop_login_from(&ssh, None).is_err());
    }

    mod login {
        use gated_db_entities::{Role, Target as DbTarget, UserRoleAssignment};
        use sea_orm::Database;

        use super::super::*;

        struct Fixture {
            db: DatabaseConnection,
            target_id: Uuid,
        }

        impl Fixture {
            async fn new() -> Self {
                let db = Database::connect("sqlite::memory:").await.expect("connect");
                gated_db_migrations::migrate_database(&db)
                    .await
                    .expect("migrate");
                let target_id = Uuid::new_v4();
                DbTarget::ActiveModel {
                    id: Set(target_id),
                    name: Set("web".into()),
                    description: Set(String::new()),
                    kind: Set(gated_db_entities::Target::TargetKind::Ssh),
                    options: Set(serde_json::json!({})),
                    rate_limit_bytes_per_second: Set(None),
                    group_id: Set(None),
                }
                .insert(&db)
                .await
                .expect("insert target");
                User::ActiveModel {
                    id: Set(Uuid::new_v4()),
                    username: Set("alice".into()),
                    description: Set(String::new()),
                    credential_policy: Set(serde_json::json!({})),
                    rate_limit_bytes_per_second: Set(None),
                    allowed_ip_ranges: Set(None),
                }
                .insert(&db)
                .await
                .expect("insert user");
                Self { db, target_id }
            }

            async fn account(&self, name: &str, binding: &str) -> i32 {
                let account = Account::ActiveModel {
                    kind: Set("ssh-password".into()),
                    name: Set(name.into()),
                    description: Set(None),
                    credentials: Set(serde_json::json!({
                        "kind": "ssh-password", "username": name, "password": "pw"
                    })
                    .to_string()),
                    tags: Set(None),
                    created_by: Set(None),
                    created_at: Set(Utc::now()),
                    updated_at: Set(Utc::now()),
                    last_used_at: Set(None),
                    rotation_due_at: Set(None),
                    ..Default::default()
                }
                .insert(&self.db)
                .await
                .expect("insert account");
                TargetAccount::ActiveModel {
                    target_id: Set(self.target_id),
                    account_id: Set(account.id),
                    role: Set(binding.into()),
                }
                .insert(&self.db)
                .await
                .expect("bind account");
                account.id
            }

            /// Grant the target to a role alice holds, mapped to `account_id`.
            async fn grant(&self, role: &str, account_id: Option<i32>, alice_member: bool) {
                let role = Role::ActiveModel {
                    id: Set(Uuid::new_v4()),
                    name: Set(role.into()),
                    description: Set(String::new()),
                    allow_file_transfer: Set(true),
                    allow_clipboard: Set(false),
                }
                .insert(&self.db)
                .await
                .expect("insert role");
                TargetRoleAssignment::ActiveModel {
                    target_id: Set(self.target_id),
                    role_id: Set(role.id),
                    account_id: Set(account_id),
                    ..Default::default()
                }
                .insert(&self.db)
                .await
                .expect("grant target");
                if alice_member {
                    let alice = User::Entity::find()
                        .filter(User::Column::Username.eq("alice"))
                        .one(&self.db)
                        .await
                        .expect("query")
                        .expect("alice");
                    UserRoleAssignment::ActiveModel {
                        user_id: Set(alice.id),
                        role_id: Set(role.id),
                        ..Default::default()
                    }
                    .insert(&self.db)
                    .await
                    .expect("assign role");
                }
            }

            async fn select(
                &self,
                requested: Option<&str>,
            ) -> Result<TargetLogin, LoginSelectionError> {
                select_login(&self.db, self.target_id, "alice", requested).await
            }
        }

        #[tokio::test]
        async fn an_unmapped_grant_keeps_the_default_login() {
            let f = Fixture::new().await;
            f.grant("ops", None, true).await;
            assert_eq!(f.select(None).await, Ok(TargetLogin::Default));
        }

        #[tokio::test]
        async fn a_role_signs_in_with_its_mapped_account() {
            let f = Fixture::new().await;
            f.account("root", "primary").await;
            let deploy = f.account("deploy", "fallback").await;
            f.grant("dev", Some(deploy), true).await;
            f.grant("dba", None, false).await;
            assert_eq!(f.select(None).await, Ok(TargetLogin::Account(deploy)));
            assert_eq!(
                f.select(Some("root")).await,
                Err(LoginSelectionError::NotAllowed("root".into()))
            );
        }

        #[tokio::test]
        async fn several_accounts_need_a_choice() {
            let f = Fixture::new().await;
            let root = f.account("root", "primary").await;
            let deploy = f.account("deploy", "fallback").await;
            f.grant("dev", Some(deploy), true).await;
            f.grant("dba", None, true).await;
            assert_eq!(
                f.select(None).await,
                Err(LoginSelectionError::Ambiguous(vec![
                    "deploy".into(),
                    "root".into()
                ]))
            );
            assert_eq!(f.select(Some("root")).await, Ok(TargetLogin::Account(root)));
            assert_eq!(
                f.select(Some("deploy")).await,
                Ok(TargetLogin::Account(deploy))
            );
        }

        #[tokio::test]
        async fn a_mapping_to_the_primary_account_is_one_choice() {
            let f = Fixture::new().await;
            let root = f.account("root", "primary").await;
            f.grant("dev", Some(root), true).await;
            f.grant("dba", None, true).await;
            let choices = login_choices(&f.db, f.target_id, "alice")
                .await
                .expect("choices");
            assert_eq!(
                choices,
                vec![LoginChoice {
                    account_id: Some(root),
                    name: Some("root".into())
                }]
            );
        }

        #[tokio::test]
        async fn without_a_grant_there_is_no_choice() {
            let f = Fixture::new().await;
            f.grant("dba", None, false).await;
            assert!(
                login_choices(&f.db, f.target_id, "alice")
                    .await
                    .expect("choices")
                    .is_empty()
            );
            assert_eq!(f.select(None).await, Ok(TargetLogin::Default));
        }
    }

    #[test]
    fn a_key_account_without_username_keeps_the_target_username() {
        let mut options = target_options();
        apply_ssh_account(&mut options, key_account("")).expect("ssh account");
        assert_eq!(options.username, "deploy");
        assert!(matches!(options.auth, SSHTargetAuth::PublicKey(_)));

        let mut options = target_options();
        apply_ssh_account(&mut options, key_account("root")).expect("ssh account");
        assert_eq!(options.username, "root");
    }
}
