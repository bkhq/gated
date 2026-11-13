use gated_common::GatedError;
use gated_core::{SharedDatabaseConnection, db_required};
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use russh::keys::{Algorithm, PrivateKey};
    use sea_orm::{ConnectionTrait, Database, Schema};
    use tokio::sync::RwLock;

    use super::*;

    fn random_key(algorithm: Algorithm) -> PublicKey {
        PrivateKey::random(&mut russh::keys::key::safe_rng(), algorithm)
            .expect("key")
            .public_key()
            .clone()
    }

    #[tokio::test]
    async fn key_of_another_type_is_a_mismatch() {
        let db = Database::connect("sqlite::memory:").await.expect("db");
        let backend = db.get_database_backend();
        let table = Schema::new(backend).create_table_from_entity(KnownHost::Entity);
        db.execute(backend.build(&table)).await.expect("table");
        let mut known_hosts = KnownHosts::new(&Arc::new(RwLock::new(Some(db))));

        let trusted = random_key(Algorithm::Ed25519);
        assert!(matches!(
            known_hosts
                .validate("host", 22, &trusted)
                .await
                .expect("validate"),
            KnownHostValidationResult::Unknown
        ));

        known_hosts
            .trust("host", 22, &trusted)
            .await
            .expect("trust");
        assert!(matches!(
            known_hosts
                .validate("host", 22, &trusted)
                .await
                .expect("validate"),
            KnownHostValidationResult::Valid
        ));

        let other_type = random_key(Algorithm::Ecdsa {
            curve: russh::keys::EcdsaCurve::NistP256,
        });
        assert!(matches!(
            known_hosts
                .validate("host", 22, &other_type)
                .await
                .expect("validate"),
            KnownHostValidationResult::Invalid { .. }
        ));
    }
}
