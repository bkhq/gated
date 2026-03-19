use anyhow::Result;
use tracing::*;
use gated_common::GlobalParams;
use gated_core::Services;

use crate::config::load_config;

pub(crate) async fn command(params: &GlobalParams, listen: &str) -> Result<()> {
    let config = match load_config(params, true) {
        Ok(config) => config,
        Err(error) => {
            error!(?error, "Failed to load config file");
            std::process::exit(1);
        }
    };

    let services = Services::new(config, None, params.clone()).await?;
    let bind_addr = listen.parse()?;

    info!("Starting Gated MCP server");
    gated_mcp::run_mcp_server(&services, bind_addr).await
}
