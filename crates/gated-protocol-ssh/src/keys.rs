use anyhow::{Context, Result};
use gated_db_entities::SshKey;
use russh::keys::{Algorithm, HashAlg, PrivateKey, decode_secret_key};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};
use tracing::*;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    /// Served to SSH clients connecting to gated.
    Host,
    /// Used to authenticate to SSH targets.
    Client,
}

impl KeyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyKind::Host => "host",
            KeyKind::Client => "client",
        }
    }
}

fn algorithms() -> [Algorithm; 2] {
    [
        Algorithm::Ed25519,
        Algorithm::Rsa {
            hash: Some(HashAlg::Sha512),
        },
    ]
}

/// Generates Ed25519 and RSA keys for each kind that has no keys yet.
/// Returns whether any key was created.
pub async fn generate_keys(db: &DatabaseConnection) -> Result<bool> {
    let tx = db.begin().await?;
    let mut created = false;
    for kind in [KeyKind::Host, KeyKind::Client] {
        if has_keys(&tx, kind).await? {
            continue;
        }
        for algorithm in algorithms() {
            info!("Generating {} key ({algorithm:?})", kind.as_str());
            let key = PrivateKey::random(&mut russh::keys::key::safe_rng(), algorithm.clone())
                .context("Failed to generate key")?;
            insert_key(&tx, kind, &key).await?;
            created = true;
        }
    }
    tx.commit().await?;
    Ok(created)
}

/// Stores an imported key of `kind`, replacing a stored key with the same
/// algorithm.
pub async fn import_key(
    db: &DatabaseConnection,
    kind: KeyKind,
    key: &PrivateKey,
) -> Result<SshKey::Model> {
    let tx = db.begin().await?;
    SshKey::Entity::delete_many()
        .filter(SshKey::Column::Kind.eq(kind.as_str()))
        .filter(SshKey::Column::Algorithm.eq(key.algorithm().to_string()))
        .exec(&tx)
        .await?;
    let model = insert_key(&tx, kind, key).await?;
    tx.commit().await?;
    Ok(model)
}

async fn insert_key(
    db: &impl ConnectionTrait,
    kind: KeyKind,
    key: &PrivateKey,
) -> Result<SshKey::Model> {
    Ok(SshKey::ActiveModel {
        id: Set(Uuid::new_v4()),
        kind: Set(kind.as_str().to_owned()),
        algorithm: Set(key.algorithm().to_string()),
        private_key_pem: Set(key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)?
            .to_string()),
        created: Set(chrono::Utc::now()),
    }
    .insert(db)
    .await?)
}

/// Lists the stored keys of both kinds.
pub async fn list_keys(db: &DatabaseConnection) -> Result<Vec<(SshKey::Model, PrivateKey)>> {
    SshKey::Entity::find()
        .order_by_asc(SshKey::Column::Kind)
        .order_by_asc(SshKey::Column::Algorithm)
        .all(db)
        .await?
        .into_iter()
        .map(|row| {
            let key = decode_secret_key(&row.private_key_pem, None)
                .with_context(|| format!("decoding stored {} key {}", row.kind, row.id))?;
            Ok((row, key))
        })
        .collect()
}

async fn has_keys(db: &impl ConnectionTrait, kind: KeyKind) -> Result<bool> {
    Ok(SshKey::Entity::find()
        .filter(SshKey::Column::Kind.eq(kind.as_str()))
        .one(db)
        .await?
        .is_some())
}

/// Loads the stored keys of `kind`; empty until they are generated.
pub async fn load_keys(db: &DatabaseConnection, kind: KeyKind) -> Result<Vec<PrivateKey>> {
    SshKey::Entity::find()
        .filter(SshKey::Column::Kind.eq(kind.as_str()))
        // `ssh-ed25519` sorts before `ssh-rsa`: offer Ed25519 first.
        .order_by_asc(SshKey::Column::Algorithm)
        .all(db)
        .await?
        .into_iter()
        .map(|row| {
            decode_secret_key(&row.private_key_pem, None)
                .with_context(|| format!("decoding stored {} key {}", row.kind, row.id))
        })
        .collect()
}
