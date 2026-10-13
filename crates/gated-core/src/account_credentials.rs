use chrono::Utc;
use gated_common::{
    AccountCredentials, BearerTokenUpstreamAuth, ClientCertificateUpstreamAuth, DbPasswordEngine,
    HeadersUpstreamAuth, SSHTargetAuth, Secret, SshTargetPasswordAuth, SshTargetPublicKeyAuth,
    Target, TargetHttpOptions, TargetOptions, TargetSSHOptions, UpstreamAuth,
};
use gated_db_entities::{Account, TargetAccount};
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};
use uuid::Uuid;

pub async fn primary_account_credentials(
    db: &DatabaseConnection,
    target_id: Uuid,
) -> Result<Option<(i32, AccountCredentials)>, String> {
    let Some(binding) = TargetAccount::Entity::find()
        .filter(TargetAccount::Column::TargetId.eq(target_id))
        .filter(TargetAccount::Column::Role.eq("primary"))
        .one(db)
        .await
        .map_err(|e| format!("query target account binding failed: {e}"))?
    else {
        return Ok(None);
    };

    let Some(account) = Account::Entity::find_by_id(binding.account_id)
        .one(db)
        .await
        .map_err(|e| format!("query account failed: {e}"))?
    else {
        return Err(format!("account {} not found", binding.account_id));
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

    Ok(Some((account.id, credentials)))
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

pub async fn resolve_db_account(
    db: &DatabaseConnection,
    target: &Target,
) -> Result<Option<(i32, gated_common::DbPasswordAccountCredentials)>, String> {
    let Some((account_id, credentials)) = primary_account_credentials(db, target.id).await? else {
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
    fallback_username: Option<&str>,
) -> Result<(TargetSSHOptions, Option<i32>), String> {
    let TargetOptions::Ssh(mut options) = target.options.clone() else {
        return Err("target is not SSH".into());
    };
    if let Some((account_id, credentials)) = primary_account_credentials(db, target.id).await? {
        match credentials {
            AccountCredentials::SshPassword(credentials) => {
                options.username = credentials.username;
                options.auth = SSHTargetAuth::Password(SshTargetPasswordAuth {
                    password: Secret::new(credentials.password),
                });
                return Ok((options, Some(account_id)));
            }
            AccountCredentials::SshKey(credentials) => {
                options.username = credentials.username;
                options.auth = SSHTargetAuth::PublicKey(SshTargetPublicKeyAuth {
                    private_key_pem: Some(Secret::new(credentials.private_key_pem)),
                    passphrase: credentials.passphrase.map(Secret::new),
                });
                return Ok((options, Some(account_id)));
            }
            _ => return Err(format!("account {account_id} is not an SSH credential")),
        }
    }

    if options.username.is_empty() {
        if let Some(username) = fallback_username {
            options.username = username.to_string();
        }
    }
    Ok((options, None))
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
