use chrono::{DateTime, Utc};
use gated_common::hash_secret;
use poem_openapi::Object;
use sea_orm::ActiveValue;
use sea_orm::entity::prelude::*;
use serde::Serialize;
use uuid::Uuid;

// `secret` is redacted from `Serialize` (`#[serde(skip)]`) and the
// OpenAPI schema (`#[oai(skip)]`), and from the manual `Debug` impl below, so
// the ticket secret never leaks through API responses or logs.
#[derive(Clone, PartialEq, Eq, DeriveEntityModel, Serialize, Object)]
#[sea_orm(table_name = "tickets")]
#[oai(rename = "Ticket")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    #[oai(skip)]
    #[serde(skip)]
    pub secret: String,
    pub username: String,
    #[sea_orm(column_type = "Text")]
    pub description: String,
    pub target: String,
    pub uses_left: Option<i16>,
    pub expiry: Option<DateTime<Utc>>,
    pub created: DateTime<Utc>,
}

impl std::fmt::Debug for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Model")
            .field("id", &self.id)
            .field("secret", &"<redacted>")
            .field("username", &self.username)
            .field("description", &self.description)
            .field("target", &self.target)
            .field("uses_left", &self.uses_left)
            .field("expiry", &self.expiry)
            .field("created", &self.created)
            .finish()
    }
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::Session::Entity")]
    Sessions,
}

// Store only a hash of the ticket secret, never the plaintext. The
// presented secret is hashed before lookup (see gated-core
// config_providers/mod.rs::authorize_ticket), so the at-rest column can never
// be replayed even if the database is read. Hashing happens here so every
// insert path is covered without each caller remembering to hash. Only inserts
// are hashed: an update never carries a fresh plaintext secret, so this avoids
// accidentally double-hashing an already-stored digest.
#[async_trait::async_trait]
impl ActiveModelBehavior for ActiveModel {
    async fn before_save<C>(mut self, _db: &C, insert: bool) -> Result<Self, DbErr>
    where
        C: ConnectionTrait,
    {
        if insert && let ActiveValue::Set(secret) = self.secret {
            self.secret = ActiveValue::Set(hash_secret(&secret));
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Model {
        Model {
            id: Uuid::nil(),
            secret: "raw-ticket-secret".into(),
            username: "alice".into(),
            description: "d".into(),
            target: "t".into(),
            uses_left: Some(1),
            expiry: None,
            created: DateTime::<Utc>::MIN_UTC,
        }
    }

    // Neither Debug nor Serialize may expose the raw secret.
    #[test]
    fn debug_and_serialize_redact_secret() {
        let model = sample();
        assert!(!format!("{model:?}").contains("raw-ticket-secret"));
        let json = serde_json::to_string(&model).unwrap();
        assert!(!json.contains("raw-ticket-secret"));
        assert!(!json.contains("secret"));
    }
}
