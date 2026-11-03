//! TLS certificates served by gated's listeners. The HTTP proxy, MySQL and
//! PostgreSQL listeners each have their own certificate stored in the
//! database; a self-signed one is generated when a listener starts without
//! one. The admin listener keeps its certificate files because it serves
//! before the database opens. Every listener serves through a
//! [`ReloadableCertResolver`], so replaced certificates apply without a restart.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use gated_common::helpers::fs::secure_file;
use gated_db_entities::TlsCertificate;
use gated_tls::{ReloadableCertResolver, RustlsSetupError, TlsCertificateAndPrivateKey};
use sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait, Set, TransactionTrait};
use tracing::info;

use crate::Services;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TlsListener {
    Admin,
    Http,
    Mysql,
    Postgres,
}

impl TlsListener {
    pub const ALL: [Self; 4] = [Self::Admin, Self::Http, Self::Mysql, Self::Postgres];
    /// Listeners whose certificate lives in the database.
    pub const DATABASE: [Self; 3] = [Self::Http, Self::Mysql, Self::Postgres];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Http => "http",
            Self::Mysql => "mysql",
            Self::Postgres => "postgres",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|listener| listener.as_str() == value)
    }
}

/// The certificate each listener serves; replaced in place on import,
/// regeneration or ACME issuance so running listeners pick it up for new
/// handshakes.
#[derive(Default)]
pub struct TlsResolvers {
    admin: Arc<ReloadableCertResolver>,
    http: Arc<ReloadableCertResolver>,
    mysql: Arc<ReloadableCertResolver>,
    postgres: Arc<ReloadableCertResolver>,
}

impl TlsResolvers {
    pub fn get(&self, listener: TlsListener) -> &Arc<ReloadableCertResolver> {
        match listener {
            TlsListener::Admin => &self.admin,
            TlsListener::Http => &self.http,
            TlsListener::Mysql => &self.mysql,
            TlsListener::Postgres => &self.postgres,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("invalid certificate or key: {0}")]
    Invalid(#[from] RustlsSetupError),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// A listener's current certificate chain and key, PEM encoded.
pub struct StoredCertificate {
    pub certificate_pem: String,
    pub private_key_pem: String,
    pub created: Option<DateTime<Utc>>,
}

pub fn parse(row: &TlsCertificate::Model) -> Result<TlsCertificateAndPrivateKey, RustlsSetupError> {
    TlsCertificateAndPrivateKey::from_pem(
        row.certificate_pem.as_bytes(),
        row.private_key_pem.as_bytes(),
    )
}

pub async fn load(
    db: &impl ConnectionTrait,
    listener: TlsListener,
) -> Result<Option<TlsCertificate::Model>> {
    Ok(TlsCertificate::Entity::find_by_id(listener.as_str())
        .one(db)
        .await?)
}

pub async fn list(db: &impl ConnectionTrait) -> Result<Vec<TlsCertificate::Model>> {
    let mut rows = Vec::new();
    for listener in TlsListener::DATABASE {
        rows.extend(load(db, listener).await?);
    }
    Ok(rows)
}

async fn save(
    db: &(impl ConnectionTrait + TransactionTrait),
    listener: TlsListener,
    certificate_pem: String,
    private_key_pem: String,
) -> Result<TlsCertificate::Model> {
    let tx = db.begin().await?;
    TlsCertificate::Entity::delete_by_id(listener.as_str())
        .exec(&tx)
        .await?;
    let row = TlsCertificate::ActiveModel {
        listener: Set(listener.as_str().to_owned()),
        certificate_pem: Set(certificate_pem),
        private_key_pem: Set(private_key_pem),
        created: Set(Utc::now()),
    }
    .insert(&tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

/// Certificate and key files of the admin listener; `None` when it serves
/// plain HTTP.
pub async fn admin_paths(services: &Services) -> Option<(PathBuf, PathBuf)> {
    let config = services.config.read().await;
    let admin = &config.store.admin;
    if !admin.tls || admin.certificate.is_empty() || admin.key.is_empty() {
        return None;
    }
    let base = services.global_params.paths_relative_to();
    Some((base.join(&admin.certificate), base.join(&admin.key)))
}

/// The listener's current certificate, if it has one.
pub async fn current(
    services: &Services,
    listener: TlsListener,
) -> Result<Option<StoredCertificate>> {
    if listener == TlsListener::Admin {
        let Some((certificate_path, key_path)) = admin_paths(services).await else {
            return Ok(None);
        };
        let Ok(certificate_pem) = tokio::fs::read_to_string(&certificate_path).await else {
            return Ok(None);
        };
        let private_key_pem = tokio::fs::read_to_string(&key_path)
            .await
            .with_context(|| format!("reading {}", key_path.display()))?;
        let created = tokio::fs::metadata(&certificate_path)
            .await
            .and_then(|meta| meta.modified())
            .ok()
            .map(DateTime::<Utc>::from);
        return Ok(Some(StoredCertificate {
            certificate_pem,
            private_key_pem,
            created,
        }));
    }
    let db = services.db_required().await?;
    Ok(load(&db, listener).await?.map(|row| StoredCertificate {
        certificate_pem: row.certificate_pem,
        private_key_pem: row.private_key_pem,
        created: Some(row.created),
    }))
}

/// Validates and stores a certificate for the listener (the admin listener's
/// files, or the database), then serves it to new connections.
pub async fn install(
    services: &Services,
    listener: TlsListener,
    certificate_pem: String,
    private_key_pem: String,
) -> Result<(), InstallError> {
    let pair = TlsCertificateAndPrivateKey::from_pem(
        certificate_pem.as_bytes(),
        private_key_pem.as_bytes(),
    )?;
    if listener == TlsListener::Admin {
        let (certificate_path, key_path) = admin_paths(services)
            .await
            .context("the admin listener has TLS disabled")?;
        tokio::fs::write(&key_path, &private_key_pem)
            .await
            .with_context(|| format!("writing {}", key_path.display()))?;
        tokio::fs::write(&certificate_path, &certificate_pem)
            .await
            .with_context(|| format!("writing {}", certificate_path.display()))?;
        if services.global_params.should_secure_files() {
            secure_file(&certificate_path).context("securing the certificate file")?;
            secure_file(&key_path).context("securing the key file")?;
        }
    } else {
        let db = services.db_required().await.map_err(anyhow::Error::from)?;
        save(&db, listener, certificate_pem, private_key_pem).await?;
    }
    services.tls_resolvers.get(listener).set(pair);
    Ok(())
}

/// Replaces the listener's certificate with a new self-signed one for
/// `external_host` (when set) and `localhost`.
pub async fn generate(services: &Services, listener: TlsListener) -> Result<()> {
    let external_host = services.config.read().await.store.external_host.clone();
    let mut names: Vec<String> = external_host.into_iter().collect();
    if !names.iter().any(|name| name == "localhost") {
        names.push("localhost".to_owned());
    }
    let cert = rcgen::generate_simple_self_signed(names)
        .context("generating a self-signed TLS certificate")?;
    info!(
        listener = listener.as_str(),
        "Generated a self-signed TLS certificate"
    );
    install(
        services,
        listener,
        cert.cert.pem(),
        cert.key_pair.serialize_pem(),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error))
}

/// Loads a database-backed listener's certificate, generating one first if
/// there is none, and installs it in the listener's resolver.
pub async fn activate(
    services: &Services,
    listener: TlsListener,
) -> Result<Arc<ReloadableCertResolver>> {
    let db = services.db_required().await?;
    match load(&db, listener).await? {
        Some(row) => {
            let pair = parse(&row)
                .with_context(|| format!("stored {} TLS certificate", listener.as_str()))?;
            services.tls_resolvers.get(listener).set(pair);
        }
        None => generate(services, listener).await?,
    }
    Ok(services.tls_resolvers.get(listener).clone())
}

#[cfg(test)]
mod tests {
    use gated_common::{GatedConfig, GlobalParams, Secret};

    use super::*;

    async fn test_services() -> Services {
        let root = std::env::temp_dir().join(format!("gated-tls-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").expect("write config");
        let mut config = GatedConfig {
            store: Default::default(),
        };
        config.store.database_url = Secret::new("sqlite:data/db".to_owned());
        config.store.external_host = Some("gated.example.com".to_owned());
        let params = GlobalParams::new(config_path, false).expect("global params");
        let services = Services::new(config, None, params, None)
            .await
            .expect("services");
        services.open_db_legacy().await.expect("open db");
        services
    }

    #[tokio::test]
    async fn activate_generates_a_separate_certificate_per_listener_once() {
        let services = test_services().await;
        let db = services.db_required().await.expect("db");

        for listener in TlsListener::DATABASE {
            activate(&services, listener).await.expect("activate");
        }
        let rows = list(&db).await.expect("list");
        assert_eq!(rows.len(), 3);
        assert_ne!(rows[0].certificate_pem, rows[1].certificate_pem);
        assert_ne!(rows[1].certificate_pem, rows[2].certificate_pem);
        let names = parse(&rows[0])
            .expect("parse")
            .certificate
            .sni_names()
            .expect("names");
        assert!(names.contains(&"gated.example.com".to_owned()));
        assert!(names.contains(&"localhost".to_owned()));

        // A stored certificate is reused.
        activate(&services, TlsListener::Http)
            .await
            .expect("activate");
        let http = load(&db, TlsListener::Http)
            .await
            .expect("load")
            .expect("row");
        assert_eq!(http, rows[0]);

        services.close_db().await;
    }

    #[test]
    fn from_pem_rejects_a_key_of_another_certificate() {
        let a = rcgen::generate_simple_self_signed(vec!["a".to_owned()]).expect("a");
        let b = rcgen::generate_simple_self_signed(vec!["b".to_owned()]).expect("b");
        assert!(
            TlsCertificateAndPrivateKey::from_pem(
                a.cert.pem().as_bytes(),
                a.key_pair.serialize_pem().as_bytes()
            )
            .is_ok()
        );
        assert!(
            TlsCertificateAndPrivateKey::from_pem(
                a.cert.pem().as_bytes(),
                b.key_pair.serialize_pem().as_bytes()
            )
            .is_err()
        );
    }
}
