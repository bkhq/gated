use chrono::{DateTime, Utc};
use gated_common::hash_secret;
use sea_orm::ActiveValue;
use sea_orm::entity::prelude::*;
use sea_orm::sea_query::ForeignKeyAction;
use serde::Serialize;
use uuid::Uuid;

// `secret` is redacted from `Serialize` (`#[serde(skip)]`) and from
// the manual `Debug` impl below so the token never leaks through API responses
// or logs. The derived `Debug` is intentionally not used.
#[derive(Clone, PartialEq, Eq, DeriveEntityModel, Serialize)]
#[sea_orm(table_name = "api_tokens")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub user_id: Uuid,
    pub label: String,
    #[serde(skip)]
    pub secret: String,
    pub created: DateTime<Utc>,
    pub expiry: DateTime<Utc>,
}

impl std::fmt::Debug for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Model")
            .field("id", &self.id)
            .field("user_id", &self.user_id)
            .field("label", &self.label)
            .field("secret", &"<redacted>")
            .field("created", &self.created)
            .field("expiry", &self.expiry)
            .finish()
    }
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    User,
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::User => Entity::belongs_to(super::User::Entity)
                .from(Column::UserId)
                .to(super::User::Column::Id)
                .on_delete(ForeignKeyAction::Cascade)
                .into(),
        }
    }
}

impl Related<super::User::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::User.def()
    }
}

// Store only a hash of the token, never the plaintext. The presented
// token is hashed before lookup (see gated-core config_providers/db.rs), so the
// at-rest column can never be replayed even if the database is read. Hashing
// happens here so every insert path is covered without each caller remembering
// to hash. Only inserts are hashed: an update never carries a fresh plaintext
// secret, so this avoids accidentally double-hashing an already-stored digest.
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
            user_id: Uuid::nil(),
            label: "ci".into(),
            secret: "raw-secret-value".into(),
            created: DateTime::<Utc>::MIN_UTC,
            expiry: DateTime::<Utc>::MAX_UTC,
        }
    }

    // Neither Debug nor Serialize may expose the raw secret.
    #[test]
    fn debug_and_serialize_redact_secret() {
        let model = sample();
        assert!(!format!("{model:?}").contains("raw-secret-value"));
        let json = serde_json::to_string(&model).unwrap();
        assert!(!json.contains("raw-secret-value"));
        assert!(!json.contains("secret"));
    }
}
