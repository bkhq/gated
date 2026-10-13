mod db;

pub use db::DatabaseConfigProvider;
use enum_dispatch::enum_dispatch;
use gated_common::auth::{AuthCredential, AuthStateUserInfo, CredentialKind, CredentialPolicy};
use gated_common::{GatedError, Secret, Target, User};
use gated_db_entities as e;
use gated_sso::SsoProviderConfig;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use tracing::*;
use uuid::Uuid;

use crate::SharedDatabaseConnection;

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

    async fn authorize_target(&mut self, username: &str, target: &str) -> Result<bool, GatedError>;

    async fn update_public_key_last_used(
        &self,
        credential: Option<AuthCredential>,
    ) -> Result<(), GatedError>;

    async fn validate_api_token(&mut self, token: &str) -> Result<Option<User>, GatedError>;
}

pub async fn authorize_ticket(
    db: &SharedDatabaseConnection,
    secret: &Secret<String>,
) -> Result<Option<(e::Ticket::Model, AuthStateUserInfo)>, GatedError> {
    let db = crate::db_required(db).await?;
    // Ticket secrets are stored as a hash, never as plaintext. Hash
    // the presented secret and match on the digest. The digest is
    // preimage-resistant, so this equality never discloses a stored secret.
    let secret_hash = gated_common::hash_secret(secret.expose_secret());
    let ticket = {
        e::Ticket::Entity::find()
            .filter(e::Ticket::Column::Secret.eq(secret_hash))
            .one(&db)
            .await?
    };
    match ticket {
        Some(ticket) => {
            if let Some(0) = ticket.uses_left {
                warn!("Ticket is used up: {}", &ticket.id);
                return Ok(None);
            }

            if let Some(datetime) = ticket.expiry
                && datetime < chrono::Utc::now()
            {
                warn!("Ticket has expired: {}", &ticket.id);
                return Ok(None);
            }
            let Some(ticket_user) = e::User::Entity::find()
                .filter(e::User::Column::Username.eq(ticket.username.clone()))
                .one(&db)
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
    db: &SharedDatabaseConnection,
    ticket_id: &Uuid,
) -> Result<(), GatedError> {
    let db = crate::db_required(db).await?;

    // Atomic, conditional decrement so concurrent requests with the same
    // single-use ticket cannot all pass: the database enforces `uses_left > 0`
    // at write time, so exactly one of N racing consumers decrements the last
    // use. Unlimited tickets (NULL `uses_left`) never match this filter and are
    // intentionally left untouched.
    let res = e::Ticket::Entity::update_many()
        .col_expr(
            e::Ticket::Column::UsesLeft,
            Expr::col(e::Ticket::Column::UsesLeft).sub(1_i16),
        )
        .filter(e::Ticket::Column::Id.eq(*ticket_id))
        .filter(e::Ticket::Column::UsesLeft.gt(0_i16))
        .exec(&db)
        .await?;

    if res.rows_affected > 0 {
        return Ok(());
    }

    // Nothing was decremented: either the ticket has unlimited uses (valid) or
    // it is exhausted / missing (must be rejected).
    match e::Ticket::Entity::find_by_id(*ticket_id).one(&db).await? {
        Some(ticket) if ticket.uses_left.is_none() => Ok(()),
        _ => Err(GatedError::InvalidTicket(*ticket_id)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sea_orm::ActiveValue::Set;
    use sea_orm::{
        ActiveModelTrait, ConnectOptions, ConnectionTrait, Database, DbBackend, Statement,
    };
    use tokio::sync::RwLock;

    use super::*;

    async fn setup_ticket_db() -> SharedDatabaseConnection {
        // A single pooled connection so all clones share the same in-memory
        // database and writes serialize against one store.
        let mut opts = ConnectOptions::new("sqlite::memory:");
        opts.max_connections(1);
        let conn = Database::connect(opts).await.expect("connect sqlite");
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            r#"CREATE TABLE tickets (
                id TEXT PRIMARY KEY,
                secret TEXT NOT NULL,
                username TEXT NOT NULL,
                description TEXT NOT NULL,
                target TEXT NOT NULL,
                uses_left INTEGER,
                expiry TEXT,
                created TEXT NOT NULL
            )"#,
        ))
        .await
        .expect("create tickets table");
        Arc::new(RwLock::new(Some(conn)))
    }

    async fn insert_ticket(db: &SharedDatabaseConnection, uses_left: Option<i16>) -> Uuid {
        let conn = crate::db_required(db).await.expect("db");
        let id = Uuid::new_v4();
        e::Ticket::ActiveModel {
            id: Set(id),
            secret: Set("s".into()),
            username: Set("u".into()),
            description: Set(String::new()),
            target: Set("t".into()),
            uses_left: Set(uses_left),
            expiry: Set(None),
            created: Set(chrono::Utc::now()),
        }
        .insert(&conn)
        .await
        .expect("insert ticket");
        id
    }

    async fn ticket_uses_left(db: &SharedDatabaseConnection, id: Uuid) -> Option<i16> {
        let conn = crate::db_required(db).await.expect("db");
        e::Ticket::Entity::find_by_id(id)
            .one(&conn)
            .await
            .expect("find")
            .expect("ticket exists")
            .uses_left
    }

    /// A single-use ticket consumed by many racing callers must succeed exactly
    /// once; the atomic conditional UPDATE rejects every other caller and the
    /// count never goes negative.
    #[tokio::test]
    async fn single_use_ticket_consumed_at_most_once() {
        let db = setup_ticket_db().await;
        let id = insert_ticket(&db, Some(1)).await;

        let mut handles = Vec::new();
        for _ in 0..16 {
            let db = db.clone();
            handles.push(tokio::spawn(async move { consume_ticket(&db, &id).await }));
        }

        let mut successes = 0;
        for h in handles {
            if h.await.expect("join").is_ok() {
                successes += 1;
            }
        }
        assert_eq!(successes, 1, "exactly one consumer should succeed");
        assert_eq!(ticket_uses_left(&db, id).await, Some(0));
    }

    /// Unlimited tickets (NULL uses_left) are never decremented and always
    /// consume successfully.
    #[tokio::test]
    async fn unlimited_ticket_always_consumes() {
        let db = setup_ticket_db().await;
        let id = insert_ticket(&db, None).await;

        for _ in 0..3 {
            consume_ticket(&db, &id).await.expect("unlimited consume");
        }
        assert_eq!(ticket_uses_left(&db, id).await, None);
    }

    /// An already-exhausted ticket is rejected.
    #[tokio::test]
    async fn exhausted_ticket_rejected() {
        let db = setup_ticket_db().await;
        let id = insert_ticket(&db, Some(0)).await;
        assert!(consume_ticket(&db, &id).await.is_err());
        assert_eq!(ticket_uses_left(&db, id).await, Some(0));
    }
}
