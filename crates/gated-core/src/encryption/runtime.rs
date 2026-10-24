use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, anyhow, ensure};
use secrecy::{ExposeSecret, SecretBox, SecretString};
use tokio::sync::{Mutex, RwLock};
use zeroize::Zeroize;

use super::crypto::{
    DEK_AAD, KdfParams, derive_kek, generate_dek, generate_salt, make_verifier, unwrap_dek, verify,
    wrap_dek,
};
use super::meta::MetaDb;
use super::migration::{MigrationOptions, MigrationReport, migrate_plaintext_database};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptionStatus {
    Disabled,
    Uninitialized,
    Locked,
    Unlocked,
    Error(String),
}

pub struct KeyMaterial {
    pub dek: SecretBox<[u8; 32]>,
    pub dek_version: u32,
}

impl Zeroize for KeyMaterial {
    fn zeroize(&mut self) {
        self.dek.zeroize();
        self.dek_version.zeroize();
    }
}

pub struct EncryptionRuntime {
    status: Arc<RwLock<EncryptionStatus>>,
    key: Arc<RwLock<Option<KeyMaterial>>>,
    operation_lock: Mutex<()>,
    meta: MetaDb,
    kdf_params: KdfParams,
}

impl EncryptionRuntime {
    pub async fn new(data_dir: &Path) -> Result<Self> {
        Self::new_with_params(data_dir, KdfParams::default()).await
    }

    async fn new_with_params(data_dir: &Path, kdf_params: KdfParams) -> Result<Self> {
        let meta = MetaDb::open(data_dir).await?;
        let status = if meta.is_initialized().await? {
            EncryptionStatus::Locked
        } else {
            EncryptionStatus::Uninitialized
        };

        Ok(Self {
            status: Arc::new(RwLock::new(status)),
            key: Arc::new(RwLock::new(None)),
            operation_lock: Mutex::new(()),
            meta,
            kdf_params,
        })
    }

    pub async fn status(&self) -> EncryptionStatus {
        self.status.read().await.clone()
    }

    pub async fn init(&self, master_pwd: SecretString) -> Result<()> {
        let _guard = self.operation_lock.lock().await;
        ensure!(
            !self.meta.is_initialized().await?,
            "encryption is already initialized"
        );

        self.init_with_generated_dek(master_pwd).await?;
        Ok(())
    }

    pub async fn init_with_plaintext_migration(
        &self,
        master_pwd: SecretString,
        database_path: &Path,
        migration_options: &MigrationOptions,
    ) -> Result<MigrationReport> {
        let _guard = self.operation_lock.lock().await;
        ensure!(
            !self.meta.is_initialized().await?,
            "encryption is already initialized"
        );

        let dek = generate_dek();
        let dek_hex = hex::encode(dek.expose_secret());
        let report = migrate_plaintext_database(database_path, &dek_hex, migration_options).await?;
        self.init_with_dek(master_pwd, dek).await?;
        Ok(report)
    }

    async fn init_with_generated_dek(&self, master_pwd: SecretString) -> Result<()> {
        self.init_with_dek(master_pwd, generate_dek()).await
    }

    async fn init_with_dek(
        &self,
        master_pwd: SecretString,
        dek: SecretBox<[u8; 32]>,
    ) -> Result<()> {
        let params = self.kdf_params;
        let salt = generate_salt();
        let kek = derive_kek(&master_pwd, &salt, &params)?;
        drop(master_pwd);
        let loaded = self
            .meta
            .initialize(params, salt, kek.expose_secret(), &dek)
            .await?;

        *self.key.write().await = Some(KeyMaterial {
            dek,
            dek_version: loaded.dek_version,
        });
        *self.status.write().await = EncryptionStatus::Unlocked;
        Ok(())
    }

    pub async fn unlock(&self, master_pwd: SecretString) -> Result<()> {
        let _guard = self.operation_lock.lock().await;
        let Some(meta) = self.meta.load().await? else {
            *self.status.write().await = EncryptionStatus::Uninitialized;
            return Err(anyhow!("encryption is not initialized"));
        };

        let kek = derive_kek(&master_pwd, &meta.kdf_salt, &meta.kdf_params)?;
        drop(master_pwd);
        if !verify(kek.expose_secret(), &meta.verifier) {
            *self.status.write().await = EncryptionStatus::Locked;
            self.meta
                .record_event("unlock", "error", Some("verifier rejected"))
                .await?;
            return Err(anyhow!("invalid encryption password"));
        }

        let dek = unwrap_dek(kek.expose_secret(), &meta.dek_wrapped, DEK_AAD)?;
        *self.key.write().await = Some(KeyMaterial {
            dek,
            dek_version: meta.dek_version,
        });
        *self.status.write().await = EncryptionStatus::Unlocked;
        self.meta.record_event("unlock", "ok", None).await?;
        Ok(())
    }

    pub async fn lock(&self) {
        let _guard = self.operation_lock.lock().await;
        if let Some(mut key) = self.key.write().await.take() {
            key.zeroize();
        }

        let status = if self.meta.is_initialized().await.unwrap_or(false) {
            EncryptionStatus::Locked
        } else {
            EncryptionStatus::Uninitialized
        };
        *self.status.write().await = status;
    }

    pub async fn rekey_master(&self, old: SecretString, new: SecretString) -> Result<()> {
        let _guard = self.operation_lock.lock().await;
        let Some(meta) = self.meta.load().await? else {
            *self.status.write().await = EncryptionStatus::Uninitialized;
            return Err(anyhow!("encryption is not initialized"));
        };

        let old_kek = derive_kek(&old, &meta.kdf_salt, &meta.kdf_params)?;
        drop(old);
        if !verify(old_kek.expose_secret(), &meta.verifier) {
            *self.status.write().await = EncryptionStatus::Locked;
            self.meta
                .record_event("rekey_master", "error", Some("verifier rejected"))
                .await?;
            return Err(anyhow!("invalid encryption password"));
        }

        let dek = unwrap_dek(old_kek.expose_secret(), &meta.dek_wrapped, DEK_AAD)?;
        let new_salt = generate_salt();
        let new_kek = derive_kek(&new, &new_salt, &meta.kdf_params)?;
        drop(new);
        let wrapped = wrap_dek(new_kek.expose_secret(), &dek, DEK_AAD)?;
        let verifier = make_verifier(new_kek.expose_secret())?;
        self.meta
            .replace_master_wrap(new_salt, meta.kdf_params, &wrapped, &verifier)
            .await?;

        let mut key = self.key.write().await;
        if key.is_some() {
            *key = Some(KeyMaterial {
                dek,
                dek_version: meta.dek_version,
            });
            *self.status.write().await = EncryptionStatus::Unlocked;
        }
        Ok(())
    }

    pub fn dek_hex(&self) -> Option<String> {
        let key = self.key.try_read().ok()?;
        let material = key.as_ref()?;
        Some(hex::encode(material.dek.expose_secret()))
    }
}

impl Drop for KeyMaterial {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use uuid::Uuid;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("gated-runtime-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn test_params() -> KdfParams {
        KdfParams {
            m_cost_kib: 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[tokio::test]
    async fn runtime_state_machine_transitions() {
        let runtime = EncryptionRuntime::new_with_params(&temp_dir("transitions"), test_params())
            .await
            .unwrap();
        assert_eq!(runtime.status().await, EncryptionStatus::Uninitialized);

        runtime
            .init(SecretString::from("master-password"))
            .await
            .unwrap();
        assert_eq!(runtime.status().await, EncryptionStatus::Unlocked);
        let first_hex = runtime.dek_hex().unwrap();
        assert_eq!(first_hex.len(), 64);

        runtime.lock().await;
        assert_eq!(runtime.status().await, EncryptionStatus::Locked);
        assert!(runtime.dek_hex().is_none());

        runtime
            .unlock(SecretString::from("master-password"))
            .await
            .unwrap();
        assert_eq!(runtime.status().await, EncryptionStatus::Unlocked);
        assert_eq!(runtime.dek_hex().unwrap(), first_hex);
    }

    #[tokio::test]
    async fn wrong_password_unlock_fails() {
        let runtime =
            EncryptionRuntime::new_with_params(&temp_dir("wrong-password"), test_params())
                .await
                .unwrap();
        runtime.init(SecretString::from("good")).await.unwrap();
        runtime.lock().await;

        assert!(runtime.unlock(SecretString::from("bad")).await.is_err());
        assert_eq!(runtime.status().await, EncryptionStatus::Locked);
        assert!(runtime.dek_hex().is_none());
    }

    #[tokio::test]
    async fn rekey_master_changes_password_without_changing_dek() {
        let runtime = EncryptionRuntime::new_with_params(&temp_dir("rekey"), test_params())
            .await
            .unwrap();
        runtime.init(SecretString::from("old")).await.unwrap();
        let dek_before = runtime.dek_hex().unwrap();

        runtime
            .rekey_master(SecretString::from("old"), SecretString::from("new"))
            .await
            .unwrap();
        runtime.lock().await;

        assert!(runtime.unlock(SecretString::from("old")).await.is_err());
        runtime.unlock(SecretString::from("new")).await.unwrap();
        assert_eq!(runtime.dek_hex().unwrap(), dek_before);
    }

    #[tokio::test]
    async fn plaintext_migration_failure_does_not_initialize_meta() {
        let dir = temp_dir("migration-fails");
        let runtime = EncryptionRuntime::new_with_params(&dir.join("encryption"), test_params())
            .await
            .unwrap();
        let missing_database = dir.join("db.sqlite3");

        assert!(
            runtime
                .init_with_plaintext_migration(
                    SecretString::from("master-password"),
                    &missing_database,
                    &crate::encryption::migration::MigrationOptions {
                        auto_delete_plaintext: false,
                        secure_files: false,
                    },
                )
                .await
                .is_err()
        );

        assert_eq!(runtime.status().await, EncryptionStatus::Uninitialized);
        assert!(runtime.dek_hex().is_none());
        assert!(
            !super::MetaDb::open(&dir.join("encryption"))
                .await
                .unwrap()
                .is_initialized()
                .await
                .unwrap()
        );
    }
}
