use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use gated_common::helpers::fs::secure_file;
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

use crate::encryption::sqlite;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExistingSqliteDatabase {
    Missing,
    Plaintext,
    EncryptedOrInvalid,
}

#[derive(Clone, Debug)]
pub struct MigrationOptions {
    pub auto_delete_plaintext: bool,
    pub secure_files: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationReport {
    pub database_path: PathBuf,
    pub backup_path: Option<PathBuf>,
}

pub async fn detect_existing_database(path: &Path) -> Result<ExistingSqliteDatabase> {
    if !path.exists() {
        return Ok(ExistingSqliteDatabase::Missing);
    }

    if can_read_sqlite_master(path).await? {
        Ok(ExistingSqliteDatabase::Plaintext)
    } else {
        Ok(ExistingSqliteDatabase::EncryptedOrInvalid)
    }
}

pub async fn migrate_plaintext_database(
    database_path: &Path,
    dek_hex: &str,
    options: &MigrationOptions,
) -> Result<MigrationReport> {
    ensure!(database_path.exists(), "sqlite database does not exist");
    ensure!(
        matches!(
            detect_existing_database(database_path).await?,
            ExistingSqliteDatabase::Plaintext
        ),
        "sqlite database is not readable plaintext"
    );
    let parent = database_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("sqlite database path has no parent"))?;
    std::fs::create_dir_all(parent).context("failed to create sqlite database directory")?;

    let tmp_path = database_path.with_file_name("db.sqlite3.enc.tmp");
    let backup_path = database_path.with_file_name("db.sqlite3.plain.bak");
    ensure!(
        !backup_path.exists(),
        "plaintext backup already exists at {}",
        backup_path.display()
    );
    remove_file_if_exists(&tmp_path).context("failed to remove stale encrypted tmp database")?;

    let source = connect_plaintext(database_path, false)
        .await
        .context("opening plaintext sqlite database")?;
    source
        .execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)")
        .await
        .context("checkpointing plaintext sqlite WAL")?;
    let source_user_version = user_version(&source).await?;
    let source_migration_versions = migration_versions(&source).await?;

    create_empty_encrypted_database(&tmp_path, dek_hex).await?;
    export_to_encrypted_tmp(&source, &tmp_path, dek_hex, source_user_version).await?;
    drop(source);

    let encrypted = connect_encrypted(&tmp_path, dek_hex)
        .await
        .context("opening migrated SQLCipher database")?;
    assert_integrity(&encrypted).await?;
    ensure!(
        source_user_version == user_version(&encrypted).await?,
        "migrated sqlite user_version does not match source"
    );
    ensure!(
        source_migration_versions == migration_versions(&encrypted).await?,
        "migrated sea-orm migration versions do not match source"
    );
    drop(encrypted);

    std::fs::rename(database_path, &backup_path).with_context(|| {
        format!(
            "failed to rename plaintext database {} to {}",
            database_path.display(),
            backup_path.display()
        )
    })?;
    move_sidecar(database_path, &backup_path, "wal")?;
    move_sidecar(database_path, &backup_path, "shm")?;
    std::fs::rename(&tmp_path, database_path).with_context(|| {
        format!(
            "failed to promote encrypted database {} to {}",
            tmp_path.display(),
            database_path.display()
        )
    })?;

    if options.secure_files {
        secure_file(database_path).context("failed to secure encrypted sqlite database")?;
        secure_file(&backup_path).context("failed to secure plaintext sqlite backup")?;
        secure_sidecar(&backup_path, "wal")?;
        secure_sidecar(&backup_path, "shm")?;
    }

    if options.auto_delete_plaintext {
        remove_file_if_exists(&backup_path).context("failed to delete plaintext backup")?;
        remove_sidecar(&backup_path, "wal")?;
        remove_sidecar(&backup_path, "shm")?;
        Ok(MigrationReport {
            database_path: database_path.to_path_buf(),
            backup_path: None,
        })
    } else {
        Ok(MigrationReport {
            database_path: database_path.to_path_buf(),
            backup_path: Some(backup_path),
        })
    }
}

async fn can_read_sqlite_master(path: &Path) -> Result<bool> {
    let db = connect_plaintext(path, true)
        .await
        .context("opening sqlite database for plaintext detection")?;
    let stmt = Statement::from_string(
        DbBackend::Sqlite,
        "SELECT name FROM sqlite_master LIMIT 1".to_owned(),
    );
    Ok(db.query_one(stmt).await.is_ok())
}

async fn connect_plaintext(path: &Path, read_only: bool) -> Result<sea_orm::DatabaseConnection> {
    let mode = if read_only { "ro" } else { "rw" };
    Database::connect(format!("sqlite:{}?mode={mode}", path.to_string_lossy()))
        .await
        .context("failed to connect sqlite database")
}

async fn connect_encrypted(path: &Path, dek_hex: &str) -> Result<sea_orm::DatabaseConnection> {
    let url = format!("sqlite:{}?mode=rw", path.to_string_lossy());
    Database::connect(sqlite::make_connect_options(&url, dek_hex)?)
        .await
        .context("failed to connect SQLCipher database")
}

async fn create_empty_encrypted_database(path: &Path, dek_hex: &str) -> Result<()> {
    let url = format!("sqlite:{}?mode=rwc", path.to_string_lossy());
    let db = Database::connect(sqlite::make_connect_options(&url, dek_hex)?)
        .await
        .context("failed to create SQLCipher tmp database")?;
    db.execute_unprepared("PRAGMA user_version = 0")
        .await
        .context("failed to initialize SQLCipher tmp database")?;
    db.close().await?;
    Ok(())
}

async fn export_to_encrypted_tmp(
    source: &sea_orm::DatabaseConnection,
    tmp_path: &Path,
    dek_hex: &str,
    user_version: i64,
) -> Result<()> {
    ensure!(dek_hex.len() == 64, "SQLCipher DEK must be 32 bytes as hex");
    ensure!(
        dek_hex.as_bytes().iter().all(u8::is_ascii_hexdigit),
        "SQLCipher DEK must be hex encoded"
    );

    let tmp = sql_literal(tmp_path);
    source
        .execute_unprepared(&format!(
            "ATTACH DATABASE {tmp} AS encrypted KEY \"x'{dek_hex}'\""
        ))
        .await
        .context("attaching encrypted SQLCipher tmp database")?;

    let result = async {
        source
            .execute_unprepared("SELECT sqlcipher_export('encrypted')")
            .await
            .context("copying plaintext sqlite database into SQLCipher tmp")?;
        source
            .execute_unprepared(&format!("PRAGMA encrypted.user_version = {user_version}"))
            .await
            .context("copying sqlite user_version into SQLCipher tmp")?;
        Result::<()>::Ok(())
    }
    .await;

    let detach = source.execute_unprepared("DETACH DATABASE encrypted").await;
    result?;
    detach.context("detaching encrypted SQLCipher tmp database")?;
    Ok(())
}

async fn assert_integrity(db: &sea_orm::DatabaseConnection) -> Result<()> {
    let row = db
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA integrity_check".to_owned(),
        ))
        .await?
        .ok_or_else(|| anyhow::anyhow!("integrity_check returned no rows"))?;
    let value: String = row.try_get("", "integrity_check")?;
    ensure!(value == "ok", "sqlite integrity_check failed: {value}");
    Ok(())
}

async fn user_version(db: &sea_orm::DatabaseConnection) -> Result<i64> {
    let row = db
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA user_version".to_owned(),
        ))
        .await?
        .ok_or_else(|| anyhow::anyhow!("user_version returned no rows"))?;
    Ok(row.try_get("", "user_version")?)
}

async fn migration_versions(db: &sea_orm::DatabaseConnection) -> Result<Vec<String>> {
    let exists = db
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seaql_migrations'"
                .to_owned(),
        ))
        .await?
        .is_some();
    if !exists {
        return Ok(Vec::new());
    }

    let rows = db
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT version FROM seaql_migrations ORDER BY version".to_owned(),
        ))
        .await?;
    rows.into_iter()
        .map(|row| row.try_get("", "version").map_err(Into::into))
        .collect()
}

fn sql_literal(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

fn move_sidecar(database_path: &Path, backup_path: &Path, suffix: &str) -> Result<()> {
    let sidecar = sidecar_path(database_path, suffix);
    if !sidecar.exists() {
        return Ok(());
    }
    let backup = sidecar_path(backup_path, suffix);
    ensure!(
        !backup.exists(),
        "plaintext backup sidecar already exists at {}",
        backup.display()
    );
    std::fs::rename(&sidecar, &backup).with_context(|| {
        format!(
            "failed to rename sqlite sidecar {} to {}",
            sidecar.display(),
            backup.display()
        )
    })?;
    Ok(())
}

fn secure_sidecar(path: &Path, suffix: &str) -> Result<()> {
    let sidecar = sidecar_path(path, suffix);
    if sidecar.exists() {
        secure_file(&sidecar)
            .with_context(|| format!("failed to secure sqlite sidecar {}", sidecar.display()))?;
    }
    Ok(())
}

fn remove_sidecar(path: &Path, suffix: &str) -> Result<()> {
    remove_file_if_exists(&sidecar_path(path, suffix))
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}-{suffix}", path.display()))
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sea_orm::ConnectionTrait;
    use uuid::Uuid;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("gated-migration-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn detects_missing_and_plaintext_database() {
        let dir = temp_dir("detect");
        let db_path = dir.join("db.sqlite3");
        assert_eq!(
            detect_existing_database(&db_path).await.unwrap(),
            ExistingSqliteDatabase::Missing
        );

        let db = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .unwrap();
        db.execute_unprepared("CREATE TABLE fixture (id INTEGER PRIMARY KEY, name TEXT)")
            .await
            .unwrap();
        drop(db);

        assert_eq!(
            detect_existing_database(&db_path).await.unwrap(),
            ExistingSqliteDatabase::Plaintext
        );
    }

    #[tokio::test]
    async fn migrates_plaintext_database_to_sqlcipher_and_preserves_backup() {
        let dir = temp_dir("roundtrip");
        let db_path = dir.join("db.sqlite3");
        let plaintext = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .unwrap();
        plaintext
            .execute_unprepared("CREATE TABLE fixture (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .await
            .unwrap();
        for idx in 0..10 {
            plaintext
                .execute_unprepared(&format!(
                    "INSERT INTO fixture (name) VALUES ('fixture-{idx}')"
                ))
                .await
                .unwrap();
        }
        plaintext
            .execute_unprepared("PRAGMA user_version = 7")
            .await
            .unwrap();
        drop(plaintext);

        let dek_hex = "11".repeat(32);
        let report = migrate_plaintext_database(
            &db_path,
            &dek_hex,
            &MigrationOptions {
                auto_delete_plaintext: false,
                secure_files: true,
            },
        )
        .await
        .unwrap();

        let backup_path = report.backup_path.unwrap();
        assert!(backup_path.exists());
        assert_eq!(
            detect_existing_database(&backup_path).await.unwrap(),
            ExistingSqliteDatabase::Plaintext
        );
        assert_eq!(
            detect_existing_database(&db_path).await.unwrap(),
            ExistingSqliteDatabase::EncryptedOrInvalid
        );

        let encrypted = connect_encrypted(&db_path, &dek_hex).await.unwrap();
        assert_integrity(&encrypted).await.unwrap();
        assert_eq!(user_version(&encrypted).await.unwrap(), 7);
        let row = encrypted
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS count FROM fixture".to_owned(),
            ))
            .await
            .unwrap()
            .unwrap();
        let count: i64 = row.try_get("", "count").unwrap();
        assert_eq!(count, 10);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&backup_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn auto_delete_plaintext_removes_backup() {
        let dir = temp_dir("auto-delete");
        let db_path = dir.join("db.sqlite3");
        let plaintext = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .unwrap();
        plaintext
            .execute_unprepared("CREATE TABLE fixture (id INTEGER PRIMARY KEY)")
            .await
            .unwrap();
        drop(plaintext);

        let report = migrate_plaintext_database(
            &db_path,
            &"22".repeat(32),
            &MigrationOptions {
                auto_delete_plaintext: true,
                secure_files: true,
            },
        )
        .await
        .unwrap();

        assert!(report.backup_path.is_none());
        assert!(!db_path.with_file_name("db.sqlite3.plain.bak").exists());
    }
}
