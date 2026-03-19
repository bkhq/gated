use anyhow::{Context, Result};
use tokio::time::timeout;
use gated_common::GlobalParams;

use crate::config::load_config;

pub(crate) async fn command(params: &GlobalParams) -> Result<()> {
    let config = load_config(params, true)?;

    let scheme = if config.store.http.tls { "https" } else { "http" };
    let url = format!(
        "{}://{}/@gated/api/info",
        scheme,
        config.store.http.listen.address()
    );

    let mut builder = reqwest::Client::builder();
    if config.store.http.tls {
        builder = builder
            .danger_accept_invalid_certs(true)
            .use_rustls_tls();
    }
    let client = builder.build()?;

    let response = timeout(std::time::Duration::from_secs(5), client.get(&url).send())
        .await
        .context("Timeout")?
        .context("Failed to send request")?;

    response.error_for_status()?;

    Ok(())
}
