mod db;
use std::sync::Arc;

pub use db::DatabaseConfigProvider;
use enum_dispatch::enum_dispatch;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;
use gated_common::auth::{AuthCredential, AuthStateUserInfo, CredentialKind, CredentialPolicy};
use gated_common::{Secret, Target, User, GatedError};
use gated_db_entities as e;
use gated_sso::SsoProviderConfig;

#[enum_dispatch]
pub enum ConfigProviderEnum {
    Database(DatabaseConfigProvider),
}

#[enum_dispatch(ConfigProviderEnum)]
#[allow(async_fn_in_trait)]
pub trait ConfigProvider {
    async fn list_users(&mut self) -> Result<Vec<User>, GatedError>;

    async fn list_targets(&mut self) -> Result<Vec<Target>, GatedError>;

    async fn validate_credential(
        &mut self,
        username: &str,
        client_credential: &AuthCredential,
    ) -> Result<bool, GatedError>;

    async fn username_for_sso_credential(
        &mut self,
        client_credential: &AuthCredential,
        preferred_username: Option<String>,
        sso_config: SsoProviderConfig,
    ) -> Result<Option<String>, GatedError>;

    async fn apply_sso_role_mappings(
        &mut self,
        username: &str,
        managed_role_names: Option<Vec<String>>,
        active_role_names: Vec<String>,
    ) -> Result<(), GatedError>;

    async fn get_credential_policy(
        &mut self,
        username: &str,
        supported_credential_types: &[CredentialKind],
    ) -> Result<Option<Box<dyn CredentialPolicy + Sync + Send>>, GatedError>;

    async fn authorize_target(
        &mut self,
        username: &str,
        target: &str,
    ) -> Result<bool, GatedError>;

    async fn update_public_key_last_used(
        &self,
        credential: Option<AuthCredential>,
    ) -> Result<(), GatedError>;

    async fn validate_api_token(&mut self, token: &str) -> Result<Option<User>, GatedError>;
}

//TODO: move this somewhere
pub async fn authorize_ticket(
    db: &Arc<Mutex<DatabaseConnection>>,
    secret: &Secret<String>,
) -> Result<Option<(e::Ticket::Model, AuthStateUserInfo)>, GatedError> {
    let db = db.lock().await;
    let ticket = {
        e::Ticket::Entity::find()
            .filter(e::Ticket::Column::Secret.eq(&secret.expose_secret()[..]))
            .one(&*db)
            .await?
    };
    match ticket {
        Some(ticket) => {
            if let Some(0) = ticket.uses_left {
                warn!("Ticket is used up: {}", &ticket.id);
                return Ok(None);
            }

            if let Some(datetime) = ticket.expiry {
                if datetime < chrono::Utc::now() {
                    warn!("Ticket has expired: {}", &ticket.id);
                    return Ok(None);
                }
            }

            // TODO maybe Ticket could properly reference the user model and then
            // AuthStateUserInfo could be constructed from it
            let Some(ticket_user) = e::User::Entity::find()
                .filter(e::User::Column::Username.eq(ticket.username.clone()))
                .one(&*db)
                .await?
            else {
                return Err(GatedError::UserNotFound(ticket.username.clone()));
            };

            Ok(Some((ticket, (&User::try_from(ticket_user)?).into())))
        }
        None => {
            warn!("Ticket not found: {}", &secret.expose_secret());
            Ok(None)
        }
    }
}

pub async fn consume_ticket(
    db: &Arc<Mutex<DatabaseConnection>>,
    ticket_id: &Uuid,
) -> Result<(), GatedError> {
    let db = db.lock().await;
    let ticket = e::Ticket::Entity::find_by_id(*ticket_id).one(&*db).await?;
    let Some(ticket) = ticket else {
        return Err(GatedError::InvalidTicket(*ticket_id));
    };

    if let Some(uses_left) = ticket.uses_left {
        let mut model: e::Ticket::ActiveModel = ticket.into();
        model.uses_left = Set(Some(uses_left - 1));
        model.update(&*db).await?;
    }

    Ok(())
}
