use chrono::Utc;
use data_encoding::BASE64;
use gated_common::auth::{
    AllCredentialsPolicy, AnySingleCredentialPolicy, AuthCredential, CredentialKind,
    CredentialPolicy, PerProtocolCredentialPolicy,
};
use gated_common::helpers::hash::verify_password_hash;
use gated_common::helpers::otp::verify_totp;
use gated_common::{
    GatedError, Role, Target, User, UserAuthCredential, UserPasswordCredential,
    UserPublicKeyCredential, UserRequireCredentialsPolicy, UserSsoCredential, UserTotpCredential,
};
use gated_db_entities as entities;
use gated_sso::SsoProviderConfig;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, ModelTrait, QueryFilter,
    QueryOrder, Set,
};
use std::collections::{HashMap, HashSet};
use tracing::*;
use uuid::Uuid;

use super::ConfigProvider;
use crate::SharedDatabaseConnection;

pub struct DatabaseConfigProvider {
    db: SharedDatabaseConnection,
}

impl DatabaseConfigProvider {
    pub async fn new(db: &SharedDatabaseConnection) -> Self {
        Self { db: db.clone() }
    }

    async fn maybe_autocreate_sso_user(
        &self,
        db: &DatabaseConnection,
        credential: UserSsoCredential,
        preferred_username: String,
    ) -> Result<Option<String>, GatedError> {
        let user = entities::User::ActiveModel {
            id: Set(Uuid::new_v4()),
            username: Set(preferred_username.clone()),
            description: Set("".into()),
            credential_policy: Set(serde_json::to_value(
                UserRequireCredentialsPolicy::default(),
            )?),
            rate_limit_bytes_per_second: Set(None),
        }
        .insert(db)
        .await?;

        entities::SsoCredential::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(user.id),
            ..credential.into()
        }
        .insert(db)
        .await?;

        info!(target: "audit", username = %preferred_username, "Auto-created SSO user {}", preferred_username);

        Ok(Some(preferred_username))
    }
}

impl ConfigProvider for DatabaseConfigProvider {
    async fn list_users(&mut self) -> Result<Vec<User>, GatedError> {
        let db = crate::db_required(&self.db).await?;

        let users = entities::User::Entity::find()
            .order_by_asc(entities::User::Column::Username)
            .all(&db)
            .await?;

        let users: Result<Vec<User>, _> = users.into_iter().map(|t| t.try_into()).collect();

        users
    }

    async fn list_targets(&mut self) -> Result<Vec<Target>, GatedError> {
        let db = crate::db_required(&self.db).await?;

        let targets = entities::Target::Entity::find()
            .order_by_asc(entities::Target::Column::Name)
            .all(&db)
            .await?;

        let targets: Result<Vec<Target>, _> = targets.into_iter().map(|t| t.try_into()).collect();

        Ok(targets?)
    }

    async fn get_credential_policy(
        &mut self,
        username: &str,
        supported_credential_types: &[CredentialKind],
    ) -> Result<Option<Box<dyn CredentialPolicy + Sync + Send>>, GatedError> {
        let db = crate::db_required(&self.db).await?;

        let user_model = entities::User::Entity::find()
            .filter(entities::User::Column::Username.eq(username))
            .one(&db)
            .await?;

        let Some(user_model) = user_model else {
            error!("Selected user not found: {}", username);
            return Ok(None);
        };

        let user = user_model.load_details(&db).await?;

        let mut available_credential_types = user
            .credentials
            .iter()
            .map(|x| x.kind())
            .collect::<HashSet<_>>();
        available_credential_types.insert(CredentialKind::WebUserApproval);

        let supported_credential_types = supported_credential_types
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .intersection(&available_credential_types)
            .copied()
            .collect::<HashSet<_>>();

        // "Any single credential" policy should not include WebUserApproval
        // if other authentication methods are available because it could lead to user confusion
        let default_policy = Box::new(AnySingleCredentialPolicy {
            supported_credential_types: if supported_credential_types.len() > 1 {
                supported_credential_types
                    .iter()
                    .cloned()
                    .filter(|x| x != &CredentialKind::WebUserApproval)
                    .collect()
            } else {
                supported_credential_types.clone()
            },
        }) as Box<dyn CredentialPolicy + Sync + Send>;

        if let Some(req) = user.credential_policy.clone() {
            let mut policy = PerProtocolCredentialPolicy {
                default: default_policy,
                protocols: HashMap::new(),
            };

            if let Some(p) = req.http {
                policy.protocols.insert(
                    "HTTP",
                    Box::new(AllCredentialsPolicy {
                        supported_credential_types: supported_credential_types.clone(),
                        required_credential_types: p.into_iter().collect(),
                    }),
                );
            }
            if let Some(p) = req.mysql {
                policy.protocols.insert(
                    "MySQL",
                    Box::new(AllCredentialsPolicy {
                        supported_credential_types: supported_credential_types.clone(),
                        required_credential_types: p.into_iter().collect(),
                    }),
                );
            }
            if let Some(p) = req.postgres {
                policy.protocols.insert(
                    "PostgreSQL",
                    Box::new(AllCredentialsPolicy {
                        supported_credential_types: supported_credential_types.clone(),
                        required_credential_types: p.into_iter().collect(),
                    }),
                );
            }
            if let Some(p) = req.ssh {
                policy.protocols.insert(
                    "SSH",
                    Box::new(AllCredentialsPolicy {
                        supported_credential_types,
                        required_credential_types: p.into_iter().collect(),
                    }),
                );
            }

            Ok(Some(
                Box::new(policy) as Box<dyn CredentialPolicy + Sync + Send>
            ))
        } else {
            Ok(Some(default_policy))
        }
    }

    async fn username_for_sso_credential(
        &mut self,
        client_credential: &AuthCredential,
        preferred_username: Option<String>,
        sso_config: SsoProviderConfig,
    ) -> Result<Option<String>, GatedError> {
        let db = crate::db_required(&self.db).await?;

        let AuthCredential::Sso {
            provider: client_provider,
            email: client_email,
            iss: client_iss,
            sub: client_sub,
        } = client_credential
        else {
            return Ok(None);
        };

        // Resolve the account by the stable OIDC identity (iss, sub),
        // never by email alone. Email is a federated, attacker-influenceable
        // attribute; matching on it allows account takeover. Rows with a NULL
        // iss/sub (manually-provisioned credentials) never match an
        // OIDC login.
        let cred = entities::SsoCredential::Entity::find()
            .filter(
                entities::SsoCredential::Column::Iss
                    .eq(client_iss)
                    .and(entities::SsoCredential::Column::Sub.eq(client_sub)),
            )
            .one(&db)
            .await?;

        if let Some(cred) = cred {
            let user = cred.find_related(entities::User::Entity).one(&db).await?;

            if let Some(user) = user {
                return Ok(Some(user.username.clone()));
            }
        }

        if sso_config.auto_create_users {
            let Some(preferred_username) = preferred_username else {
                error!("The OIDC server did not provide a preferred_username claim for this user");
                return Ok(None);
            };
            return self
                .maybe_autocreate_sso_user(
                    &db,
                    UserSsoCredential {
                        email: client_email.clone(),
                        provider: Some(client_provider.clone()),
                        iss: Some(client_iss.clone()),
                        sub: Some(client_sub.clone()),
                    },
                    preferred_username,
                )
                .await;
        }

        Ok(None)
    }

    async fn validate_credential(
        &mut self,
        username: &str,
        client_credential: &AuthCredential,
    ) -> Result<bool, GatedError> {
        let db = crate::db_required(&self.db).await?;

        let user_model = entities::User::Entity::find()
            .filter(entities::User::Column::Username.eq(username))
            .one(&db)
            .await?;

        let Some(user_model) = user_model else {
            error!("Selected user not found: {}", username);
            return Ok(false);
        };

        let user_details = user_model.load_details(&db).await?;

        match client_credential {
            AuthCredential::PublicKey {
                kind,
                public_key_bytes,
            } => {
                let base64_bytes = BASE64.encode(public_key_bytes);
                let openssh_public_key = format!("{kind} {base64_bytes}");
                debug!(
                    username = &user_details.username[..],
                    "Client key: {}", openssh_public_key
                );

                Ok(user_details
                    .credentials
                    .iter()
                    .any(|credential| match credential {
                        UserAuthCredential::PublicKey(UserPublicKeyCredential {
                            key: ref user_key,
                        }) => &openssh_public_key == user_key.expose_secret(),
                        _ => false,
                    }))
            }
            AuthCredential::Password(client_password) => {
                Ok(user_details
                    .credentials
                    .iter()
                    .any(|credential| match credential {
                        UserAuthCredential::Password(UserPasswordCredential {
                            hash: ref user_password_hash,
                        }) => verify_password_hash(
                            client_password.expose_secret(),
                            user_password_hash.expose_secret(),
                        )
                        .unwrap_or_else(|e| {
                            error!(
                                username = &user_details.username[..],
                                "Error verifying password hash: {}", e
                            );
                            false
                        }),
                        _ => false,
                    }))
            }
            AuthCredential::Otp(client_otp) => {
                Ok(user_details
                    .credentials
                    .iter()
                    .any(|credential| match credential {
                        UserAuthCredential::Totp(UserTotpCredential {
                            key: ref user_otp_key,
                        }) => verify_totp(client_otp.expose_secret(), user_otp_key),
                        _ => false,
                    }))
            }
            AuthCredential::Sso {
                iss: client_iss,
                sub: client_sub,
                ..
            } => {
                // Validate against the stable (iss, sub) identity,
                // not provider/email. Credentials with a NULL iss/sub cannot
                // be authenticated via OIDC.
                for credential in user_details.credentials.iter() {
                    if let UserAuthCredential::Sso(UserSsoCredential {
                        ref iss, ref sub, ..
                    }) = credential
                    {
                        if iss.as_deref() == Some(client_iss.as_str())
                            && sub.as_deref() == Some(client_sub.as_str())
                        {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
            _ => Err(GatedError::InvalidCredentialType),
        }
    }

    async fn authorize_target(
        &mut self,
        username: &str,
        target_name: &str,
    ) -> Result<bool, GatedError> {
        let db = crate::db_required(&self.db).await?;

        let target_model = entities::Target::Entity::find()
            .filter(entities::Target::Column::Name.eq(target_name))
            .one(&db)
            .await?;

        let user_model = entities::User::Entity::find()
            .filter(entities::User::Column::Username.eq(username))
            .one(&db)
            .await?;

        let Some(user_model) = user_model else {
            error!("Selected user not found: {}", username);
            return Ok(false);
        };

        let Some(target_model) = target_model else {
            warn!("Selected target not found: {}", target_name);
            return Ok(false);
        };

        let target_roles: HashSet<String> = target_model
            .find_related(entities::Role::Entity)
            .all(&db)
            .await?
            .into_iter()
            .map(Into::<Role>::into)
            .map(|x| x.name)
            .collect();

        let user_roles: HashSet<String> = user_model
            .find_related(entities::Role::Entity)
            .all(&db)
            .await?
            .into_iter()
            .map(Into::<Role>::into)
            .map(|x| x.name)
            .collect();

        let intersect = user_roles.intersection(&target_roles).count() > 0;

        Ok(intersect)
    }

    async fn apply_sso_role_mappings(
        &mut self,
        username: &str,
        managed_role_names: Option<Vec<String>>,
        assigned_role_names: Vec<String>,
    ) -> Result<(), GatedError> {
        let db = crate::db_required(&self.db).await?;

        let user = entities::User::Entity::find()
            .filter(entities::User::Column::Username.eq(username))
            .one(&db)
            .await?
            .ok_or_else(|| GatedError::UserNotFound(username.into()))?;

        // Absence of a mapping config means SSO manages NO roles, so an IdP
        // cannot grant or revoke any role (including admin) from raw claims.
        let managed_role_names = managed_role_names.unwrap_or_default();

        for role_name in managed_role_names.into_iter() {
            let role = entities::Role::Entity::find()
                .filter(entities::Role::Column::Name.eq(role_name.clone()))
                .one(&db)
                .await?
                .ok_or_else(|| GatedError::RoleNotFound(role_name.clone()))?;

            let assignment = entities::UserRoleAssignment::Entity::find()
                .filter(entities::UserRoleAssignment::Column::UserId.eq(user.id))
                .filter(entities::UserRoleAssignment::Column::RoleId.eq(role.id))
                .one(&db)
                .await?;

            match (assignment, assigned_role_names.contains(&role_name)) {
                (None, true) => {
                    info!(target: "audit", username = %username, "Adding role {role_name} for user {username} (from SSO)");
                    let values = entities::UserRoleAssignment::ActiveModel {
                        user_id: Set(user.id),
                        role_id: Set(role.id),
                        ..Default::default()
                    };

                    values.insert(&db).await?;
                }
                (Some(assignment), false) => {
                    info!(target: "audit", username = %username, "Removing role {role_name} for user {username} (from SSO)");
                    assignment.delete(&db).await?;
                }
                _ => (),
            }
        }

        Ok(())
    }

    async fn update_public_key_last_used(
        &self,
        credential: Option<AuthCredential>,
    ) -> Result<(), GatedError> {
        let db = crate::db_required(&self.db).await?;

        let Some(AuthCredential::PublicKey {
            kind,
            public_key_bytes,
        }) = credential
        else {
            error!("Invalid or missing public key credential");
            return Err(GatedError::InvalidCredentialType);
        };

        // Encode public key and match it against the database
        let base64_bytes = data_encoding::BASE64.encode(&public_key_bytes);
        let openssh_public_key = format!("{kind} {base64_bytes}");

        debug!(
            "Attempting to update last_used for public key: {}",
            openssh_public_key
        );

        // Find the public key credential
        let public_key_credential = entities::PublicKeyCredential::Entity::find()
            .filter(
                entities::PublicKeyCredential::Column::OpensshPublicKey
                    .eq(openssh_public_key.clone()),
            )
            .one(&db)
            .await?;

        let Some(public_key_credential) = public_key_credential else {
            warn!(
                "Public key not found in the database: {}",
                openssh_public_key
            );
            return Ok(()); // Gracefully return if the key is not found
        };

        // Update the `last_used` (last used) timestamp
        let mut active_model: entities::PublicKeyCredential::ActiveModel =
            public_key_credential.into();
        active_model.last_used = Set(Some(Utc::now()));

        active_model.update(&db).await.map_err(|e| {
            error!("Failed to update last_used for public key: {:?}", e);
            GatedError::DatabaseError(e)
        })?;

        Ok(())
    }

    async fn validate_api_token(&mut self, token: &str) -> Result<Option<User>, GatedError> {
        let db = crate::db_required(&self.db).await?;
        // Tokens are stored as a hash, never as plaintext. Hash the
        // presented token and match on the digest. The digest is
        // preimage-resistant, so this equality never discloses a stored secret.
        let token_hash = gated_common::hash_secret(token);
        let Some(ticket) = entities::ApiToken::Entity::find()
            .filter(
                entities::ApiToken::Column::Secret
                    .eq(token_hash)
                    .and(entities::ApiToken::Column::Expiry.gt(Utc::now())),
            )
            .one(&db)
            .await?
        else {
            return Ok(None);
        };

        let Some(user) = ticket.find_related(entities::User::Entity).one(&db).await? else {
            return Err(GatedError::InconsistentState);
        };

        Ok(Some(user.try_into()?))
    }
}

#[cfg(all(test, feature = "sqlite"))]
mod tests {
    use std::sync::Arc;

    use gated_common::auth::AuthCredential;
    use gated_db_migrations::migrate_database;
    use sea_orm::{ActiveModelTrait, Database, Set};
    use tokio::sync::RwLock;
    use uuid::Uuid;

    use super::*;

    const ISS: &str = "https://idp.example.com";
    const EMAIL: &str = "alice@example.com";

    async fn setup() -> SharedDatabaseConnection {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite memory");
        migrate_database(&conn).await.expect("migrate");

        let user_id = Uuid::new_v4();
        entities::User::ActiveModel {
            id: Set(user_id),
            username: Set("alice".into()),
            description: Set(String::new()),
            credential_policy: Set(serde_json::json!({})),
            rate_limit_bytes_per_second: Set(None),
        }
        .insert(&conn)
        .await
        .expect("insert user");

        entities::SsoCredential::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(user_id),
            provider: Set(Some("corp".into())),
            email: Set(EMAIL.into()),
            iss: Set(Some(ISS.into())),
            sub: Set(Some("sub-alice-123".into())),
        }
        .insert(&conn)
        .await
        .expect("insert sso credential");

        Arc::new(RwLock::new(Some(conn)))
    }

    fn provider_config(auto_create: bool) -> SsoProviderConfig {
        serde_json::from_value(serde_json::json!({
            "name": "corp",
            "label": null,
            "provider": {
                "type": "custom",
                "client_id": "cid",
                "client_secret": "secret",
                "issuer_url": ISS,
                "scopes": [],
                "role_mappings": null,
                "additional_trusted_audiences": null,
            },
            "return_domain_whitelist": null,
            "auto_create_users": auto_create,
        }))
        .expect("build provider config")
    }

    fn sso_cred(email: &str, iss: &str, sub: &str) -> AuthCredential {
        AuthCredential::Sso {
            provider: "corp".into(),
            email: email.into(),
            iss: iss.into(),
            sub: sub.into(),
        }
    }

    // The existing account is resolved by its (iss, sub) identity.
    #[tokio::test]
    async fn resolves_account_by_iss_sub() {
        let db = setup().await;
        let mut cp = DatabaseConfigProvider::new(&db).await;

        let username = cp
            .username_for_sso_credential(
                &sso_cred(EMAIL, ISS, "sub-alice-123"),
                Some("alice".into()),
                provider_config(false),
            )
            .await
            .unwrap();
        assert_eq!(username, Some("alice".to_string()));
    }

    // A login with the SAME email but a DIFFERENT sub must NOT match
    // the existing account (no email-based account takeover).
    #[tokio::test]
    async fn same_email_different_sub_does_not_match() {
        let db = setup().await;
        let mut cp = DatabaseConfigProvider::new(&db).await;

        let username = cp
            .username_for_sso_credential(
                &sso_cred(EMAIL, ISS, "sub-attacker-999"),
                None,
                provider_config(false),
            )
            .await
            .unwrap();
        assert_eq!(username, None);
    }

    // A login with the SAME email but a DIFFERENT issuer must NOT
    // match the existing account.
    #[tokio::test]
    async fn same_email_different_iss_does_not_match() {
        let db = setup().await;
        let mut cp = DatabaseConfigProvider::new(&db).await;

        let username = cp
            .username_for_sso_credential(
                &sso_cred(EMAIL, "https://evil.example.com", "sub-alice-123"),
                None,
                provider_config(false),
            )
            .await
            .unwrap();
        assert_eq!(username, None);
    }

    // An API token is stored as a hash, never as plaintext, and is
    // still resolvable by presenting the original plaintext token.
    #[tokio::test]
    async fn api_token_is_hashed_at_rest_and_still_validates() {
        let db = setup().await;
        let conn = crate::db_required(&db).await.unwrap();

        let user = entities::User::Entity::find()
            .filter(entities::User::Column::Username.eq("alice"))
            .one(&conn)
            .await
            .unwrap()
            .expect("alice exists");

        let plaintext = "plaintext-api-token-value";
        let stored = entities::ApiToken::ActiveModel {
            id: Set(Uuid::new_v4()),
            user_id: Set(user.id),
            label: Set("ci".into()),
            secret: Set(plaintext.to_string()),
            created: Set(chrono::Utc::now()),
            expiry: Set(chrono::Utc::now() + chrono::Duration::hours(1)),
        }
        .insert(&conn)
        .await
        .expect("insert api token");

        // before_save replaced the plaintext with its digest at rest.
        assert_ne!(stored.secret, plaintext);
        assert_eq!(stored.secret, gated_common::hash_secret(plaintext));

        let mut cp = DatabaseConfigProvider::new(&db).await;
        let resolved = cp.validate_api_token(plaintext).await.unwrap();
        assert_eq!(resolved.map(|u| u.username), Some("alice".to_string()));

        // The stored hash is not itself a valid token.
        assert!(cp
            .validate_api_token(&stored.secret)
            .await
            .unwrap()
            .is_none());
    }

    // A ticket secret is stored as a hash, never as plaintext, and is
    // still resolvable by presenting the original plaintext secret.
    #[tokio::test]
    async fn ticket_secret_is_hashed_at_rest_and_still_authorizes() {
        let db = setup().await;
        let conn = crate::db_required(&db).await.unwrap();

        let plaintext = "plaintext-ticket-secret-value";
        let stored = entities::Ticket::ActiveModel {
            id: Set(Uuid::new_v4()),
            secret: Set(plaintext.to_string()),
            username: Set("alice".into()),
            description: Set(String::new()),
            target: Set("server".into()),
            uses_left: Set(Some(1)),
            expiry: Set(None),
            created: Set(chrono::Utc::now()),
        }
        .insert(&conn)
        .await
        .expect("insert ticket");

        // before_save replaced the plaintext with its digest at rest.
        assert_ne!(stored.secret, plaintext);
        assert_eq!(stored.secret, gated_common::hash_secret(plaintext));

        // Presenting the original plaintext still authorizes the ticket.
        let presented = gated_common::Secret::new(plaintext.to_string());
        let authorized = crate::config_providers::authorize_ticket(&db, &presented)
            .await
            .unwrap();
        assert_eq!(
            authorized.map(|(t, _)| t.username),
            Some("alice".to_string())
        );

        // The raw stored digest is not itself a valid presented secret.
        let digest_as_secret = gated_common::Secret::new(stored.secret.clone());
        assert!(
            crate::config_providers::authorize_ticket(&db, &digest_as_secret)
                .await
                .unwrap()
                .is_none()
        );
    }

    // Auto-create with a fresh (iss, sub) but a colliding email must
    // create a NEW user rather than hijacking the existing email owner.
    #[tokio::test]
    async fn autocreate_with_colliding_email_does_not_hijack() {
        let db = setup().await;
        let mut cp = DatabaseConfigProvider::new(&db).await;

        let username = cp
            .username_for_sso_credential(
                &sso_cred(EMAIL, ISS, "sub-bob-999"),
                Some("bob".into()),
                provider_config(true),
            )
            .await
            .unwrap();
        assert_eq!(username, Some("bob".to_string()));
    }
}
