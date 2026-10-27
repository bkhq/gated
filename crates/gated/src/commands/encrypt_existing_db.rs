use anyhow::{Context, Result, ensure};
use dialoguer::Password;
use gated_common::GlobalParams;
use gated_core::encryption::migration::{
    ExistingSqliteDatabase, MigrationOptions, detect_existing_database,
};
use gated_core::encryption::{EncryptionRuntime, EncryptionStatus};
use secrecy::SecretString;

use crate::config::load_config;

pub(crate) async fn command(
    params: &GlobalParams,
    auto_delete_plaintext: bool,
    master_password: Option<String>,
) -> Result<()> {
    let config = load_config(params, true)?;

    let Some(database_path) = gated_core::db::sqlite_database_path(&config, params)? else {
        anyhow::bail!("encrypt-existing-db only supports sqlite database URLs");
    };
    ensure!(
        matches!(
            detect_existing_database(&database_path).await?,
            ExistingSqliteDatabase::Plaintext
        ),
        "existing sqlite database is not readable plaintext: {}",
        database_path.display()
    );

    let encryption_dir = params.encryption_dir();
    let runtime = EncryptionRuntime::new(&encryption_dir)
        .await
        .context("opening encryption runtime")?;
    ensure!(
        matches!(runtime.status().await, EncryptionStatus::Uninitialized),
        "encryption metadata is already initialized"
    );

    let master_password = match master_password {
        Some(master_password) => master_password,
        None => Password::new()
            .with_prompt("Master password")
            .interact()
            .context("reading master password")?,
    };
    let report = runtime
        .init_with_plaintext_migration(
            SecretString::from(master_password),
            &database_path,
            &MigrationOptions {
                auto_delete_plaintext,
                secure_files: params.should_secure_files(),
            },
        )
        .await
        .context("migrating plaintext sqlite database to SQLCipher")?;
    let dek_hex = runtime
        .dek_hex()
        .ok_or_else(|| anyhow::anyhow!("encryption runtime is unlocked without a DEK"))?;

    let opts = gated_core::db::make_sqlcipher_connect_options(&config, params, &dek_hex)
        .await
        .context("building encrypted database options")?;
    let db = sea_orm::Database::connect(opts)
        .await
        .context("opening encrypted database after migration")?;
    db.close().await?;

    println!(
        "encrypted sqlite database: {}",
        report.database_path.display()
    );
    if let Some(backup_path) = report.backup_path {
        println!("plaintext backup retained: {}", backup_path.display());
    } else {
        println!("plaintext backup deleted");
    }
    Ok(())
}
