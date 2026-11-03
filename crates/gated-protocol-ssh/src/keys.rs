//! SSH host keys, stored in the database. Keys used to authenticate to
//! targets belong to `ssh-key` accounts or to the target itself.

use anyhow::{Context, Result};
use gated_db_entities::SshKey;
use russh::keys::{Algorithm, HashAlg, PrivateKey, decode_secret_key};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};
use tracing::*;
use uuid::Uuid;

const HOST: &str = "host";

fn algorithms() -> [Algorithm; 2] {
    [
        Algorithm::Ed25519,
        Algorithm::Rsa {
            hash: Some(HashAlg::Sha512),
        },
    ]
}

/// Generates Ed25519 and RSA host keys unless host keys exist. Returns
/// whether any key was created.
pub async fn generate_keys(db: &DatabaseConnection) -> Result<bool> {
    let tx = db.begin().await?;
    if host_query().one(&tx).await?.is_some() {
        return Ok(false);
    }
    for algorithm in algorithms() {
        info!("Generating host key ({algorithm:?})");
        let key = PrivateKey::random(&mut russh::keys::key::safe_rng(), algorithm.clone())
            .context("Failed to generate key")?;
        insert_key(&tx, &key).await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// Stores an imported host key, replacing a stored host key with the same
/// algorithm.
pub async fn import_key(db: &DatabaseConnection, key: &PrivateKey) -> Result<SshKey::Model> {
    let tx = db.begin().await?;
    SshKey::Entity::delete_many()
        .filter(SshKey::Column::Kind.eq(HOST))
        .filter(SshKey::Column::Algorithm.eq(key.algorithm().to_string()))
        .exec(&tx)
        .await?;
    let model = insert_key(&tx, key).await?;
    tx.commit().await?;
    Ok(model)
}

async fn insert_key(db: &impl ConnectionTrait, key: &PrivateKey) -> Result<SshKey::Model> {
    Ok(SshKey::ActiveModel {
        id: Set(Uuid::new_v4()),
        kind: Set(HOST.to_owned()),
        algorithm: Set(key.algorithm().to_string()),
        private_key_pem: Set(key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)?
            .to_string()),
        created: Set(chrono::Utc::now()),
    }
    .insert(db)
    .await?)
}

fn host_query() -> sea_orm::Select<SshKey::Entity> {
    SshKey::Entity::find()
        .filter(SshKey::Column::Kind.eq(HOST))
        // `ssh-ed25519` sorts before `ssh-rsa`: offer Ed25519 first.
        .order_by_asc(SshKey::Column::Algorithm)
}

/// Lists the stored host keys with their rows.
pub async fn list_keys(db: &DatabaseConnection) -> Result<Vec<(SshKey::Model, PrivateKey)>> {
    host_query()
        .all(db)
        .await?
        .into_iter()
        .map(|row| {
            let key = decode_secret_key(&row.private_key_pem, None)
                .with_context(|| format!("decoding stored host key {}", row.id))?;
            Ok((row, key))
        })
        .collect()
}

/// Loads the stored host keys; empty until they are generated or imported.
pub async fn load_keys(db: &DatabaseConnection) -> Result<Vec<PrivateKey>> {
    Ok(list_keys(db)
        .await?
        .into_iter()
        .map(|(_, key)| key)
        .collect())
}
