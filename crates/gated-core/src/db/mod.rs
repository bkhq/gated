use std::time::Duration;

use anyhow::Result;
use gated_common::helpers::fs::secure_file;
use gated_common::{GatedConfig, GatedError, GlobalParams};
use gated_db_entities::{LogEntry, Parameters, Role};
use gated_db_migrations::migrate_database;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectOptions, Database, DatabaseConnection, EntityTrait,
    ModelTrait, QueryFilter, TransactionTrait,
};
use tracing::*;
use uuid::Uuid;

use crate::consts::BUILTIN_ADMIN_ROLE_NAME;
use crate::recordings::SessionRecordings;

pub async fn connect_to_db(
    config: &GatedConfig,
    params: &GlobalParams,
) -> Result<DatabaseConnection> {
    let connection = open_db_connection(config, params).await?;
    migrate_database(&connection).await?;
    Ok(connection)
}

/// Open a DB connection without running migrations. Used by the deep
/// healthcheck so it can compare the migration status separately rather
/// than silently applying pending migrations on every probe.
pub async fn open_db_connection(
    config: &GatedConfig,
    params: &GlobalParams,
) -> Result<DatabaseConnection> {
    let opt = make_connect_options(config, params).await?;
    Ok(Database::connect(opt).await?)
}

pub async fn make_connect_options(
    config: &GatedConfig,
    params: &GlobalParams,
) -> Result<ConnectOptions> {
    let url = prepare_database_url(config, params, true).await?;
    let mut opt = ConnectOptions::new(url.to_string());
    apply_pool_options(&mut opt);
    Ok(opt)
}

pub async fn make_sqlcipher_connect_options(
    config: &GatedConfig,
    params: &GlobalParams,
    dek_hex: &str,
) -> Result<ConnectOptions> {
    let url = prepare_database_url(config, params, false).await?;
    anyhow::ensure!(
        url.scheme() == "sqlite",
        "encrypted database lifecycle only supports sqlite"
    );
    let mut opt = crate::encryption::sqlite::make_connect_options(url.as_ref(), dek_hex)?;
    apply_pool_options(&mut opt);
    Ok(opt)
}

pub fn sqlite_database_path(
    config: &GatedConfig,
    params: &GlobalParams,
) -> Result<Option<std::path::PathBuf>> {
    let url = url::Url::parse(&config.store.database_url.expose_secret()[..])?;
    if url.scheme() != "sqlite" {
        return Ok(None);
    }

    let mut abs_path = params.paths_relative_to().clone();
    abs_path.push(url.path());
    abs_path.push("db.sqlite3");
    Ok(Some(abs_path))
}

async fn prepare_database_url(
    config: &GatedConfig,
    params: &GlobalParams,
    touch_sqlite: bool,
) -> Result<url::Url> {
    let mut url = url::Url::parse(&config.store.database_url.expose_secret()[..])?;
    if url.scheme() == "sqlite" {
        let abs_path = sqlite_database_path(config, params)?
            .ok_or_else(|| anyhow::anyhow!("sqlite database path unavailable"))?;

        if let Some(parent) = abs_path.parent() {
            std::fs::create_dir_all(parent)?
        }

        url.set_path(
            abs_path
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Failed to convert database path to string"))?,
        );

        url.set_query(Some("mode=rwc"));

        if touch_sqlite {
            let db = Database::connect(ConnectOptions::new(url.to_string())).await?;
            db.begin().await?.commit().await?;
        }

        if touch_sqlite && params.should_secure_files() {
            secure_file(&abs_path)?;
        }
    }

    Ok(url)
}

pub fn apply_pool_options(opt: &mut ConnectOptions) {
    opt.max_connections(100)
        .min_connections(5)
        .connect_timeout(Duration::from_secs(8))
        .idle_timeout(Duration::from_secs(8))
        .max_lifetime(Duration::from_secs(8))
        .sqlx_logging(true);
}

pub async fn populate_db(
    db: &mut DatabaseConnection,
    _config: &mut GatedConfig,
) -> Result<(), GatedError> {
    use gated_db_entities::{Recording, Session};
    use sea_orm::ActiveValue::Set;

    Recording::Entity::update_many()
        .set(Recording::ActiveModel {
            ended: Set(Some(chrono::Utc::now())),
            ..Default::default()
        })
        .filter(Expr::col(Recording::Column::Ended).is_null())
        .exec(db)
        .await
        .map_err(GatedError::from)?;

    Session::Entity::update_many()
        .set(Session::ActiveModel {
            ended: Set(Some(chrono::Utc::now())),
            ..Default::default()
        })
        .filter(Expr::col(Session::Column::Ended).is_null())
        .exec(db)
        .await
        .map_err(GatedError::from)?;

    if Role::Entity::find()
        .filter(Role::Column::Name.eq(BUILTIN_ADMIN_ROLE_NAME))
        .one(db)
        .await?
        .is_none()
    {
        let values = Role::ActiveModel {
            id: Set(Uuid::new_v4()),
            description: Set("Built-in admin role".into()),
            name: Set(BUILTIN_ADMIN_ROLE_NAME.to_owned()),
            allow_file_transfer: Set(true),
        };
        values.insert(&*db).await.map_err(GatedError::from)?;
    }

    // Generate CA certificate if not yet initialized
    let params = Parameters::Entity::get(db)
        .await
        .map_err(GatedError::from)?;
    if params.ca_certificate_pem.is_empty() || params.ca_private_key_pem.is_empty() {
        info!("Generating CA certificate");
        let (cert_pem, key_pem) = gated_ca::generate_root_certificate_rcgen()?;
        let mut active: Parameters::ActiveModel = params.into();
        active.ca_certificate_pem = Set(cert_pem);
        active.ca_private_key_pem = Set(key_pem);
        active.update(&*db).await.map_err(GatedError::from)?;
    }

    Ok(())
}

pub async fn cleanup_db(
    db: &mut DatabaseConnection,
    recordings: &mut SessionRecordings,
    retention: &Duration,
    management_retention: &Duration,
) -> Result<()> {
    use gated_db_entities::{Recording, Session};
    let management_cutoff = chrono::Utc::now() - chrono::Duration::from_std(*management_retention)?;
    gated_db_entities::ManagementAudit::Entity::delete_many()
        .filter(
            Expr::col(gated_db_entities::ManagementAudit::Column::Timestamp).lt(management_cutoff),
        )
        .exec(db)
        .await?;
    let cutoff = chrono::Utc::now() - chrono::Duration::from_std(*retention)?;

    LogEntry::Entity::delete_many()
        .filter(Expr::col(LogEntry::Column::Timestamp).lt(cutoff))
        .exec(db)
        .await?;

    let recordings_to_delete = Recording::Entity::find()
        .filter(Expr::col(Session::Column::Ended).is_not_null())
        .filter(Expr::col(Session::Column::Ended).lt(cutoff))
        .all(db)
        .await?;

    for recording in recordings_to_delete {
        if let Err(error) = recordings
            .remove(&recording.session_id, &recording.name)
            .await
        {
            error!(session=%recording.session_id, name=%recording.name, %error, "Failed to remove recording");
        }
        recording.delete(db).await?;
    }

    Session::Entity::delete_many()
        .filter(Expr::col(Session::Column::Ended).is_not_null())
        .filter(Expr::col(Session::Column::Ended).lt(cutoff))
        .exec(db)
        .await?;

    Ok(())
}
