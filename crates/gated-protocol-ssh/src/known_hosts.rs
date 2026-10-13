use gated_common::GatedError;
use gated_core::{db_required, SharedDatabaseConnection};
use gated_db_entities::KnownHost;
use russh::keys::{PublicKey, PublicKeyBase64};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter};
use uuid::Uuid;

pub struct KnownHosts {
    db: SharedDatabaseConnection,
}

pub enum KnownHostValidationResult {
    Valid,
    Invalid {
        key_type: String,
        key_base64: String,
    },
    Unknown,
}

impl KnownHosts {
    pub fn new(db: &SharedDatabaseConnection) -> Self {
        Self { db: db.clone() }
    }

    pub async fn validate(
        &mut self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> Result<KnownHostValidationResult, GatedError> {
        let db = db_required(&self.db).await?;
        let entries = KnownHost::Entity::find()
            .filter(KnownHost::Column::Host.eq(host))
            .filter(KnownHost::Column::Port.eq(port))
            .filter(KnownHost::Column::KeyType.eq(key.algorithm().as_str()))
            .all(&db)
            .await?;

        let key_base64 = key.public_key_base64();
        if entries.iter().any(|x| x.key_base64 == key_base64) {
            return Ok(KnownHostValidationResult::Valid);
        }
        if let Some(first) = entries.first() {
            return Ok(KnownHostValidationResult::Invalid {
                key_type: first.key_type.clone(),
                key_base64: first.key_base64.clone(),
            });
        }
        Ok(KnownHostValidationResult::Unknown)
    }

    pub async fn trust(
        &mut self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> Result<(), GatedError> {
        use sea_orm::ActiveValue::Set;

        let values = KnownHost::ActiveModel {
            id: Set(Uuid::new_v4()),
            host: Set(host.to_owned()),
            port: Set(port.into()),
            key_type: Set(key.algorithm().to_string()),
            key_base64: Set(key.public_key_base64()),
        };

        let db = db_required(&self.db).await?;
        values.insert(&db).await?;

        Ok(())
    }
}
