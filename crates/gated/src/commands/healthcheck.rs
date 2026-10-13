use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

use anyhow::{Context, Result};
use gated_common::GlobalParams;
use gated_core::db::open_db_connection;
use gated_core::healthcheck::{DeepHealthOptions, DeepHealthStatus, deep_check};
use tokio::time::timeout;

use crate::config::load_config;

pub(crate) async fn command(params: &GlobalParams, deep: bool, skip_lookups: bool) -> Result<()> {
    if deep {
        return run_deep(params, skip_lookups).await;
    }
    run_basic(params).await
}

async fn run_basic(params: &GlobalParams) -> Result<()> {
    let config = load_config(params, true)?;

    let scheme = if config.store.http.tls {
        "https"
    } else {
        "http"
    };

    // The liveness probe always targets the local instance. Disable TLS
    // verification only when we are unambiguously talking to loopback; for a
    // routable listen address, verify the presented certificate instead of
    // blanket-accepting any cert. An unspecified bind (0.0.0.0 /
    // [::]) covers loopback too, so probe it over loopback explicitly.
    let listen = config.store.http.listen.address();
    let ip = listen.ip();
    let (host_for_url, accept_invalid) = if ip.is_loopback() {
        (listen.to_string(), true)
    } else if ip.is_unspecified() {
        let loopback = if listen.is_ipv6() {
            SocketAddr::new(Ipv6Addr::LOCALHOST.into(), listen.port())
        } else {
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), listen.port())
        };
        (loopback.to_string(), true)
    } else {
        (listen.to_string(), false)
    };
    let url = format!("{scheme}://{host_for_url}/api/info");

    let mut builder = reqwest::Client::builder();
    if config.store.http.tls {
        builder = builder.use_rustls_tls();
        if accept_invalid {
            builder = builder.danger_accept_invalid_certs(true);
        }
    }
    let client = builder.build()?;

    let response = timeout(std::time::Duration::from_secs(5), client.get(&url).send())
        .await
        .context("Timeout")?
        .context("Failed to send request")?;

    response.error_for_status()?;

    Ok(())
}

async fn run_deep(params: &GlobalParams, skip_lookups: bool) -> Result<()> {
    let config = load_config(params, true)?;
    // Use `open_db_connection` (not `Services::new`) so deep check sees
    // the real migration state rather than one where we just migrated.
    let db = open_db_connection(&config, params).await?;
    let report = deep_check(
        &db,
        &config,
        params.paths_relative_to(),
        DeepHealthOptions { skip_lookups },
    )
    .await;

    let json = serde_json::to_string_pretty(&report)?;
    println!("{json}");

    match report.status {
        DeepHealthStatus::Ok | DeepHealthStatus::Warn => Ok(()),
        // Exit 1 without an anyhow backtrace — Docker HEALTHCHECK only
        // reads the exit code, and the JSON we already printed is a
        // cleaner failure signal than a Rust stack trace.
        DeepHealthStatus::Fail => std::process::exit(1),
    }
}
