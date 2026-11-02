//! TLS certificates of the HTTP proxy, MySQL and PostgreSQL listeners. Each
//! listener has its own certificate, stored in the database; a self-signed
//! one is generated when a listener starts without one. The admin listener
//! keeps its certificate files because it serves before the database opens.

use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::Utc;
use gated_db_entities::TlsCertificate;
use gated_tls::{ReloadableCertResolver, RustlsSetupError, TlsCertificateAndPrivateKey};
use sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait, Set, TransactionTrait};
use tracing::info;

use crate::Services;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TlsListener {
    Http,
    Mysql,
    Postgres,
}

impl TlsListener {
    pub const ALL: [Self; 3] = [Self::Http, Self::Mysql, Self::Postgres];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Mysql => "mysql",
            Self::Postgres => "postgres",
        }
    }
}

/// The certificate each listener serves; replaced in place on import or
/// regeneration so running listeners pick it up for new handshakes.
#[derive(Default)]
pub struct TlsResolvers {
    http: Arc<ReloadableCertResolver>,
    mysql: Arc<ReloadableCertResolver>,
    postgres: Arc<ReloadableCertResolver>,
}

impl TlsResolvers {
    pub fn get(&self, listener: TlsListener) -> &Arc<ReloadableCertResolver> {
        match listener {
            TlsListener::Http => &self.http,
            TlsListener::Mysql => &self.mysql,
            TlsListener::Postgres => &self.postgres,
        }
    }
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
    for listener in TlsListener::ALL {
        rows.extend(load(db, listener).await?);
    }
    Ok(rows)
}

/// Stores a certificate for the listener, replacing the current one. The
/// pair must have been validated with [`TlsCertificateAndPrivateKey::from_pem`].
pub async fn save(
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

/// Replaces the listener's certificate with a new self-signed one for
/// `external_host` (when set) and `localhost`.
pub async fn generate(
    db: &(impl ConnectionTrait + TransactionTrait),
    listener: TlsListener,
    external_host: Option<&str>,
) -> Result<TlsCertificate::Model> {
    let mut names: Vec<String> = external_host.map(str::to_owned).into_iter().collect();
    if !names.iter().any(|name| name == "localhost") {
        names.push("localhost".to_owned());
    }
    let cert = rcgen::generate_simple_self_signed(names)
        .context("generating a self-signed TLS certificate")?;
    info!(
        listener = listener.as_str(),
        "Generated a self-signed TLS certificate"
    );
    save(db, listener, cert.cert.pem(), cert.key_pair.serialize_pem()).await
}

/// Loads the listener's certificate, generating one first if there is none,
/// and installs it in the listener's resolver.
pub async fn activate(
    services: &Services,
    listener: TlsListener,
) -> Result<Arc<ReloadableCertResolver>> {
    let db = services.db_required().await?;
    let row = match load(&db, listener).await? {
        Some(row) => row,
        None => {
            let external_host = services.config.read().await.store.external_host.clone();
            generate(&db, listener, external_host.as_deref()).await?
        }
    };
    let pair =
        parse(&row).with_context(|| format!("stored {} TLS certificate", listener.as_str()))?;
    let resolver = services.tls_resolvers.get(listener);
    resolver.set(pair);
    Ok(resolver.clone())
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

        for listener in TlsListener::ALL {
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
