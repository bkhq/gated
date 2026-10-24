//! Deep health checks for the running gateway.
//!
//! Used by two callers:
//!
//! 1. The `gated healthcheck --deep` CLI command, which opens a DB
//!    connection *without* applying migrations and prints the
//!    [`DeepHealthReport`] as JSON on stdout. Exits non-zero if overall
//!    status is `fail`.
//! 2. The `/readyz` HTTP endpoint mounted on the metrics listener (see
//!    `crates/gated/src/commands/run.rs`), which runs the same report
//!    against the live `Services` and responds `200` or `503`.
//!
//! Every individual check reports its own status so Kubernetes / Grafana
//! can surface exactly which subsystem is unhappy. A single failed
//! check rolls up to `DeepHealthStatus::Fail` overall; `Warn` rolls up
//! to `Warn` unless something else is failing.
//!
//! DB probes run concurrently via `tokio::join!` so a dead DB surfaces
//! within the longest per-probe timeout rather than their sum. Callers
//! that need a hard upper bound (e.g. K8s `/readyz`) should wrap the
//! whole sweep in an outer `tokio::time::timeout`.

use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc};
use gated_common::GatedConfig;
use gated_db_migrations::Migrator;
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement, TransactionTrait};
use sea_orm_migration::MigratorTrait;
use serde::{Deserialize, Serialize};

/// Cert-expiry WARN threshold.
const TLS_WARN_DAYS: i64 = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeepHealthStatus {
    Ok,
    Warn,
    Fail,
}

impl DeepHealthStatus {
    fn worse_of(self, other: Self) -> Self {
        use DeepHealthStatus::*;
        match (self, other) {
            (Fail, _) | (_, Fail) => Fail,
            (Warn, _) | (_, Warn) => Warn,
            _ => Ok,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeepHealthCheck {
    pub name: String,
    pub status: DeepHealthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeepHealthReport {
    pub status: DeepHealthStatus,
    pub generated_at: DateTime<Utc>,
    pub checks: Vec<DeepHealthCheck>,
}

#[derive(Default, Clone, Debug)]
pub struct DeepHealthOptions {
    /// Skip network probes that talk to external systems (SSO).
    /// Local checks (DB, migrations, TLS on-disk cert) always run.
    pub skip_lookups: bool,
}

/// Run the full deep-check sweep and roll individual check statuses up
/// to an overall `status` field. DB probes run concurrently so the
/// report latency is roughly max(probe timeout) on a dead DB rather
/// than sum(timeouts).
pub async fn deep_check(
    db: &DatabaseConnection,
    config: &GatedConfig,
    paths_relative_to: &Path,
    opts: DeepHealthOptions,
) -> DeepHealthReport {
    let (ping, migrations, tx_rt) = tokio::join!(
        check_db_ping(db),
        check_db_migrations(db),
        check_db_tx_roundtrip(db)
    );

    let mut checks = vec![ping, migrations, tx_rt];
    checks.push(check_tls_cert(config, paths_relative_to));

    if !opts.skip_lookups {
        checks.push(check_sso(config).await);
    }

    let status = checks
        .iter()
        .map(|c| c.status)
        .fold(DeepHealthStatus::Ok, DeepHealthStatus::worse_of);

    DeepHealthReport {
        status,
        generated_at: Utc::now(),
        checks,
    }
}

async fn check_db_ping(db: &DatabaseConnection) -> DeepHealthCheck {
    let backend = db.get_database_backend();
    let stmt = Statement::from_string(backend, "SELECT 1".to_owned());
    match tokio::time::timeout(Duration::from_millis(700), db.execute(stmt)).await {
        Ok(Ok(_)) => ok("db.ping"),
        Ok(Err(e)) => fail("db.ping", format!("query failed: {e}")),
        Err(_) => fail("db.ping", "query timed out after 700ms"),
    }
}

async fn check_db_migrations(db: &DatabaseConnection) -> DeepHealthCheck {
    match tokio::time::timeout(
        Duration::from_millis(700),
        Migrator::get_pending_migrations(db),
    )
    .await
    {
        Ok(Ok(pending)) => {
            if pending.is_empty() {
                ok("db.migrations")
            } else {
                let names: Vec<String> = pending.iter().map(|m| m.name().to_owned()).collect();
                fail(
                    "db.migrations",
                    format!("{} pending migration(s): {}", names.len(), names.join(", ")),
                )
            }
        }
        Ok(Err(e)) => fail(
            "db.migrations",
            format!("migration status query failed: {e}"),
        ),
        Err(_) => fail(
            "db.migrations",
            "migration status query timed out after 700ms",
        ),
    }
}

async fn check_db_tx_roundtrip(db: &DatabaseConnection) -> DeepHealthCheck {
    // BEGIN + COMMIT with no body. Not a real write probe (sqlx/sea-orm
    // may skip the commit record on engines that support it), but it
    // verifies the connection can still speak the tx protocol — enough
    // to catch pool saturation, broken ACLs, or a dead server. A true
    // write probe would need a dedicated table and risks either disk
    // churn on every /readyz hit or schema drift; not worth it here.
    match tokio::time::timeout(Duration::from_millis(700), async {
        let tx = db.begin().await?;
        tx.commit().await
    })
    .await
    {
        Ok(Ok(())) => ok("db.tx_roundtrip"),
        Ok(Err(e)) => fail("db.tx_roundtrip", format!("tx commit failed: {e}")),
        Err(_) => fail("db.tx_roundtrip", "tx probe timed out after 700ms"),
    }
}

fn check_tls_cert(config: &GatedConfig, paths_relative_to: &Path) -> DeepHealthCheck {
    if !config.store.admin.tls {
        return DeepHealthCheck {
            name: "tls.cert".into(),
            status: DeepHealthStatus::Ok,
            message: Some("HTTPS disabled — no cert to check".into()),
        };
    }
    let cert_path = &config.store.admin.certificate;
    if cert_path.is_empty() {
        return warn("tls.cert", "http.certificate is empty in config");
    }
    let resolved = if std::path::Path::new(cert_path).is_absolute() {
        std::path::PathBuf::from(cert_path)
    } else {
        paths_relative_to.join(cert_path)
    };

    let pem_bytes = match std::fs::read(&resolved) {
        Ok(b) => b,
        Err(e) => {
            return fail(
                "tls.cert",
                format!("cannot read {}: {e}", resolved.display()),
            );
        }
    };

    // PEM may contain a chain; the leaf is the first block.
    let first_block = match x509_parser::pem::Pem::iter_from_buffer(&pem_bytes).next() {
        Some(Ok(p)) => p,
        Some(Err(e)) => return fail("tls.cert", format!("PEM parse error: {e}")),
        None => return fail("tls.cert", "PEM file contains no certificates"),
    };
    let parsed = match first_block.parse_x509() {
        Ok(p) => p,
        Err(e) => return fail("tls.cert", format!("X.509 parse error: {e}")),
    };

    let now = Utc::now();
    let not_after = parsed.validity().not_after.timestamp();
    let not_after =
        DateTime::<Utc>::from_timestamp(not_after, 0).unwrap_or(now - chrono::Duration::seconds(1));
    if not_after <= now {
        return fail("tls.cert", format!("expired at {}", not_after.to_rfc3339()));
    }
    let days_left = (not_after - now).num_days();
    if days_left < TLS_WARN_DAYS {
        return warn(
            "tls.cert",
            format!("expires in {days_left} day(s) ({})", not_after.to_rfc3339()),
        );
    }
    DeepHealthCheck {
        name: "tls.cert".into(),
        status: DeepHealthStatus::Ok,
        message: Some(format!("valid for {days_left} day(s)")),
    }
}

async fn check_sso(config: &GatedConfig) -> DeepHealthCheck {
    if config.store.sso_providers.is_empty() {
        return DeepHealthCheck {
            name: "sso.reachability".into(),
            status: DeepHealthStatus::Ok,
            message: Some("no SSO providers configured".into()),
        };
    }
    // Discovery-URL probes aren't implemented yet. Report `warn` so
    // "not implemented" doesn't get miscounted as "healthy" by alerting.
    warn(
        "sso.reachability",
        format!(
            "{} SSO provider(s) configured — reachability probe not implemented",
            config.store.sso_providers.len()
        ),
    )
}

fn ok(name: &str) -> DeepHealthCheck {
    DeepHealthCheck {
        name: name.into(),
        status: DeepHealthStatus::Ok,
        message: None,
    }
}

fn warn(name: &str, msg: impl Into<String>) -> DeepHealthCheck {
    DeepHealthCheck {
        name: name.into(),
        status: DeepHealthStatus::Warn,
        message: Some(msg.into()),
    }
}

fn fail(name: &str, msg: impl Into<String>) -> DeepHealthCheck {
    DeepHealthCheck {
        name: name.into(),
        status: DeepHealthStatus::Fail,
        message: Some(msg.into()),
    }
}
