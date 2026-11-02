use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, ensure};
use base64ct::{Base64, Encoding};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};
use uuid::Uuid;

use super::crypto::{
    DEK_AAD, KdfParams, Verifier, WrappedDek, decode_array, make_verifier, verify, wrap_dek,
};

const SCHEMA_VERSION: u32 = 1;
const CIPHER: &str = "sqlcipher-4";
const KDF: &str = "argon2id";

const CREATE_META: &str = r#"
CREATE TABLE IF NOT EXISTS encryption_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;

const CREATE_EVENTS: &str = r#"
CREATE TABLE IF NOT EXISTS encryption_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;

#[derive(Clone)]
pub struct MetaDb {
    db: DatabaseConnection,
    path: PathBuf,
}

#[derive(Clone)]
pub struct EncryptionMeta {
    pub kdf_params: KdfParams,
    pub kdf_salt: [u8; 32],
    pub dek_wrapped: WrappedDek,
    pub dek_version: u32,
    pub verifier: Verifier,
}

impl MetaDb {
    pub async fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("failed to create encryption data directory")?;
        let path = data_dir.join("meta.db");
        let url = format!("sqlite:{}?mode=rwc", path.to_string_lossy());
        let db = Database::connect(url)
            .await
            .context("failed to open encryption meta.db")?;
        db.execute_unprepared(CREATE_META)
            .await
            .context("failed to create encryption_meta")?;
        db.execute_unprepared(CREATE_EVENTS)
            .await
            .context("failed to create encryption_events")?;

        let meta = Self { db, path };
        meta.validate_schema_version().await?;
        Ok(meta)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn is_initialized(&self) -> Result<bool> {
        Ok(self.get("schema_version").await?.is_some())
    }

    pub async fn load(&self) -> Result<Option<EncryptionMeta>> {
        if !self.is_initialized().await? {
            return Ok(None);
        }

        let schema_version = self.required("schema_version").await?;
        ensure!(
            schema_version == SCHEMA_VERSION.to_string(),
            "unsupported meta.db schema version"
        );
        ensure!(
            self.required("cipher").await? == CIPHER,
            "unsupported encryption cipher"
        );
        ensure!(
            self.required("kdf").await? == KDF,
            "unsupported encryption KDF"
        );

        let kdf_params = serde_json::from_str(&self.required("kdf_params").await?)
            .context("invalid KDF params")?;
        let kdf_salt =
            decode_array::<32>(&self.required("kdf_salt").await?).context("invalid KDF salt")?;
        let dek_wrapped = serde_json::from_str(&self.required("dek_wrapped").await?)
            .context("invalid wrapped DEK")?;
        let dek_version = self
            .required("dek_version")
            .await?
            .parse::<u32>()
            .context("invalid DEK version")?;
        let verifier =
            serde_json::from_str(&self.required("verifier").await?).context("invalid verifier")?;

        Ok(Some(EncryptionMeta {
            kdf_params,
            kdf_salt,
            dek_wrapped,
            dek_version,
            verifier,
        }))
    }

    pub async fn initialize(
        &self,
        kdf_params: KdfParams,
        kdf_salt: [u8; 32],
        kek: &[u8; 32],
        dek: &secrecy::SecretBox<[u8; 32]>,
    ) -> Result<EncryptionMeta> {
        ensure!(
            !self.is_initialized().await?,
            "encryption meta.db is already initialized"
        );
        let dek_wrapped = wrap_dek(kek, dek, DEK_AAD)?;
        let verifier = make_verifier(kek)?;
        let loaded = EncryptionMeta {
            kdf_params,
            kdf_salt,
            dek_wrapped,
            dek_version: 1,
            verifier,
        };

        let txn = self.db.begin().await?;
        set_on(&txn, "schema_version", &SCHEMA_VERSION.to_string()).await?;
        set_on(&txn, "cipher", CIPHER).await?;
        set_on(&txn, "kdf", KDF).await?;
        set_on(
            &txn,
            "kdf_params",
            &serde_json::to_string(&loaded.kdf_params).context("failed to serialize KDF params")?,
        )
        .await?;
        set_on(&txn, "kdf_salt", &Base64::encode_string(&loaded.kdf_salt)).await?;
        set_on(
            &txn,
            "dek_wrapped",
            &serde_json::to_string(&loaded.dek_wrapped)
                .context("failed to serialize wrapped DEK")?,
        )
        .await?;
        set_on(&txn, "dek_version", &loaded.dek_version.to_string()).await?;
        set_on(
            &txn,
            "verifier",
            &serde_json::to_string(&loaded.verifier).context("failed to serialize verifier")?,
        )
        .await?;
        set_on(&txn, "initialized_at", &chrono::Utc::now().to_rfc3339()).await?;
        set_on(&txn, "last_rekey_at", "").await?;
        record_event_on(&txn, "init", "ok", None).await?;
        txn.commit().await?;

        Ok(loaded)
    }

    pub async fn replace_master_wrap(
        &self,
        new_salt: [u8; 32],
        new_kdf_params: KdfParams,
        wrapped: &WrappedDek,
        verifier: &Verifier,
    ) -> Result<()> {
        ensure!(
            self.is_initialized().await?,
            "encryption meta.db is not initialized"
        );
        let txn = self.db.begin().await?;
        set_on(
            &txn,
            "kdf_params",
            &serde_json::to_string(&new_kdf_params).context("failed to serialize KDF params")?,
        )
        .await?;
        set_on(&txn, "kdf_salt", &Base64::encode_string(&new_salt)).await?;
        set_on(
            &txn,
            "dek_wrapped",
            &serde_json::to_string(wrapped).context("failed to serialize wrapped DEK")?,
        )
        .await?;
        set_on(
            &txn,
            "verifier",
            &serde_json::to_string(verifier).context("failed to serialize verifier")?,
        )
        .await?;
        set_on(&txn, "last_rekey_at", &chrono::Utc::now().to_rfc3339()).await?;
        record_event_on(&txn, "rekey_master", "ok", None).await?;
        txn.commit().await?;
        Ok(())
    }

    pub async fn verifier_accepts(&self, kek: &[u8; 32]) -> Result<bool> {
        let Some(meta) = self.load().await? else {
            return Ok(false);
        };
        Ok(verify(kek, &meta.verifier))
    }

    pub async fn record_event(
        &self,
        event: &str,
        result: &str,
        detail: Option<&str>,
    ) -> Result<()> {
        record_event_on(&self.db, event, result, detail).await
    }

    async fn validate_schema_version(&self) -> Result<()> {
        let Some(version) = self.get("schema_version").await? else {
            return Ok(());
        };
        ensure!(
            version == SCHEMA_VERSION.to_string(),
            "unsupported meta.db schema version"
        );
        Ok(())
    }

    async fn required(&self, key: &str) -> Result<String> {
        self.get(key)
            .await?
            .ok_or_else(|| anyhow!("missing encryption meta key: {key}"))
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        get_on(&self.db, key).await
    }
}

async fn get_on<C>(conn: &C, key: &str) -> Result<Option<String>>
where
    C: ConnectionTrait,
{
    let stmt = Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "SELECT value FROM encryption_meta WHERE key = ?",
        [key.into()],
    );
    let Some(row) = conn.query_one(stmt).await? else {
        return Ok(None);
    };
    Ok(Some(row.try_get("", "value")?))
}

async fn set_on<C>(conn: &C, key: &str, value: &str) -> Result<()>
where
    C: ConnectionTrait,
{
    let stmt = Statement::from_sql_and_values(
        DbBackend::Sqlite,
        r#"
        INSERT INTO encryption_meta (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
        "#,
        [key.into(), value.into()],
    );
    conn.execute(stmt).await?;
    Ok(())
}

async fn record_event_on<C>(conn: &C, event: &str, result: &str, detail: Option<&str>) -> Result<()>
where
    C: ConnectionTrait,
{
    let stmt = Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO encryption_events (id, event, result, detail) VALUES (?, ?, ?, ?)",
        [
            Uuid::new_v4().to_string().into(),
            event.into(),
            result.into(),
            detail.map(str::to_owned).into(),
        ],
    );
    conn.execute(stmt).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use secrecy::{ExposeSecret, SecretString};

    use super::*;
    use crate::encryption::crypto::{derive_kek, generate_dek};

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("gated-encryption-{name}-{}", Uuid::new_v4()));
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
    async fn open_creates_empty_meta_db() {
        let dir = temp_dir("create-empty");
        let meta = MetaDb::open(&dir).await.unwrap();

        assert!(meta.path().exists());
        assert!(!meta.is_initialized().await.unwrap());
        assert!(meta.load().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn open_existing_initialized_meta_db() {
        let dir = temp_dir("open-existing");
        let password = SecretString::from("password");
        let salt = [1_u8; 32];
        let kek = derive_kek(&password, &salt, &test_params()).unwrap();
        let dek = generate_dek();

        MetaDb::open(&dir)
            .await
            .unwrap()
            .initialize(test_params(), salt, kek.expose_secret(), &dek)
            .await
            .unwrap();

        let reopened = MetaDb::open(&dir).await.unwrap();
        let loaded = reopened.load().await.unwrap().unwrap();
        assert_eq!(loaded.dek_version, 1);
        assert!(
            reopened
                .verifier_accepts(kek.expose_secret())
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn schema_version_mismatch_fails_open() {
        let dir = temp_dir("schema-mismatch");
        let meta = MetaDb::open(&dir).await.unwrap();
        set_on(&meta.db, "schema_version", "99").await.unwrap();

        let error = match MetaDb::open(&dir).await {
            Ok(_) => panic!("expected schema mismatch error"),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("unsupported meta.db schema version")
        );
    }

    #[tokio::test]
    async fn verifier_rejects_wrong_password() {
        let dir = temp_dir("wrong-password");
        let salt = [2_u8; 32];
        let params = test_params();
        let good = derive_kek(&SecretString::from("good"), &salt, &params).unwrap();
        let bad = derive_kek(&SecretString::from("bad"), &salt, &params).unwrap();
        let meta = MetaDb::open(&dir).await.unwrap();

        meta.initialize(params, salt, good.expose_secret(), &generate_dek())
            .await
            .unwrap();

        assert!(meta.verifier_accepts(good.expose_secret()).await.unwrap());
        assert!(!meta.verifier_accepts(bad.expose_secret()).await.unwrap());
    }
}
