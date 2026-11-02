use gated_common::{GlobalParams, Secret};
use gated_core::Services;

use crate::config::load_config;

pub(crate) async fn command(
    params: &GlobalParams,
    username: &str,
    password: &Secret<String>,
    role: &Option<String>,
) -> anyhow::Result<()> {
    let config = load_config(params, true)?;
    let services = Services::new(config.clone(), None, params.clone(), None).await?;
    services.open_db_legacy().await?;

    let db = services.db_required().await?;
    gated_core::db::create_user(&db, username, password, role.as_deref()).await?;
    services.close_db().await;
    Ok(())
}
