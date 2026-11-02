use anyhow::{Context, Result};
use gated_common::GlobalParams;
use gated_tls::{TlsCertificateBundle, TlsPrivateKey};
use tracing::*;

use crate::config::load_config;

pub(crate) async fn command(params: &GlobalParams) -> Result<()> {
    let config = load_config(params, true)?;
    TlsCertificateBundle::from_file(
        params
            .paths_relative_to()
            .join(&config.store.admin.certificate),
    )
    .await
    .with_context(|| "Checking HTTPS certificate".to_string())?;
    TlsPrivateKey::from_file(params.paths_relative_to().join(&config.store.admin.key))
        .await
        .with_context(|| "Checking HTTPS key".to_string())?;
    info!("No problems found");
    Ok(())
}
