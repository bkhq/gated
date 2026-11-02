use sea_orm::{ConnectionTrait, Statement};
use sea_orm_migration::prelude::*;
use sha2::{Digest, Sha256};
use uuid::Uuid;

// Ticket secrets were stored in plaintext. They are now stored as a
// SHA-256 hash and looked up by hashing the presented secret (see gated-core
// config_providers/mod.rs::authorize_ticket and gated-db-entities Ticket
// before_save).
//
// This migration rewrites every existing `tickets.secret` in place to its hash
// so previously-issued tickets keep working after the upgrade (the holder still
// presents the same plaintext, which now hashes to the stored digest). The
// transformation is one-way, so `down` cannot restore the plaintext.
#[derive(DeriveMigrationName)]
pub struct Migration;

/// SHA-256 as lowercase hex. Must match `gated_common::hash_secret` exactly so
/// the migrated digests line up with what the lookup path computes.
fn hash_secret(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        let backend = conn.get_database_backend();

        // A desynced dev database may have this migration pending without the
        // `tickets` table present yet; the read then errors and there is
        // nothing to rewrite. (`SchemaManager::has_table` is avoided here: it
        // needs sea-orm-migration's own sqlx-sqlite feature, which is not
        // enabled in every crate that runs these migrations.)
        let Ok(rows) = conn
            .query_all(Statement::from_string(
                backend,
                "SELECT id, secret FROM tickets".to_owned(),
            ))
            .await
        else {
            return Ok(());
        };

        for row in rows {
            let id: Uuid = row.try_get("", "id")?;
            let secret: String = row.try_get("", "secret")?;
            let hashed = hash_secret(&secret);

            conn.execute(Statement::from_sql_and_values(
                backend,
                "UPDATE tickets SET secret = ? WHERE id = ?",
                [hashed.into(), id.into()],
            ))
            .await?;
        }

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Hashing is one-way; the original plaintext cannot be recovered.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Locks the digest format to lowercase hex SHA-256 (matching
    // `gated_common::hash_secret`) via a known test vector.
    #[test]
    fn hash_secret_matches_known_vector() {
        assert_eq!(
            hash_secret("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
