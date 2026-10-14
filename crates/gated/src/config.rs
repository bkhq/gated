use std::sync::Arc;

use anyhow::{Context, Result};
use config::{Config, Environment, File, FileFormat};
use gated_common::helpers::fs::ensure_file_secure;
use gated_common::{GatedConfig, GatedConfigStore, GlobalParams};
use notify::{RecursiveMode, Watcher, recommended_watcher};
use tokio::sync::{RwLock, broadcast, mpsc};
use tracing::*;

pub fn load_config(params: &GlobalParams, secure: bool) -> Result<GatedConfig> {
    // Secure-before-read. Verify (and tighten) the config file's
    // permissions BEFORE reading its secret-bearing contents, and fail closed
    // if the file is group/world accessible and cannot be secured — rather than
    // reading secrets from an insecure file and tightening afterwards.
    if secure && params.should_secure_files() {
        ensure_file_secure(params.config_path()).context("Could not secure config")?;
    }

    let store = parse_config_store(
        Config::builder()
            .add_source(File::new(
                params
                    .config_path()
                    .to_str()
                    .context("Invalid config path")?,
                FileFormat::Yaml,
            ))
            .add_source(Environment::with_prefix("GATED"))
            .build()
            .context("Could not load config")?,
    )?;

    let config = GatedConfig { store };

    info!("Using config: {:?}", params.config_path());
    config.validate();
    Ok(config)
}

fn parse_config_store(config: Config) -> Result<GatedConfigStore> {
    let mut store: serde_json::Value = config.try_deserialize().context("Could not parse YAML")?;

    check_and_migrate_config(&mut store);

    serde_json::from_value(store).context("Could not load config")
}

pub(crate) fn serialize_config_store(store: &GatedConfigStore) -> Result<String> {
    serde_saphyr::to_string(store).context("Could not serialize config")
}

fn check_and_migrate_config(store: &mut serde_json::Value) {
    use serde_json::{Value, json};
    let Some(map) = store.as_object_mut() else {
        return;
    };

    if let Some(web_admin) = map.remove("web_admin") {
        warn!("The `web_admin` config section is deprecated. Rename it to `http`.");
        map.insert("http".into(), web_admin);
    }

    if let Some(Value::Array(users)) = map.get_mut("users") {
        for user in users {
            if let Value::Object(user) = user
                && let Some(Value::Array(old_requires)) = user.get("require")
            {
                let new_require = json!({ "ssh": old_requires, "http": old_requires });
                user.insert("require".into(), new_require);
            }
        }
    }
}

pub fn watch_config(
    params: &GlobalParams,
    config: Arc<RwLock<GatedConfig>>,
) -> Result<broadcast::Receiver<()>> {
    let params = params.clone();

    let (tx, mut rx) = mpsc::channel(16);
    let mut watcher = recommended_watcher(move |res| {
        let _ = tx.blocking_send(res);
    })?;
    watcher.watch(params.config_path().as_ref(), RecursiveMode::NonRecursive)?;

    let (tx2, rx2) = broadcast::channel(16);
    tokio::spawn(async move {
        let _watcher = watcher; // avoid dropping the watcher
        loop {
            match rx.recv().await {
                Some(Ok(event)) => {
                    if event.kind.is_modify() {
                        // Secure-before-read on reload too. On an
                        // error (incl. an insecure file that can't be secured)
                        // the old config is kept — i.e. we fail closed instead
                        // of reloading secrets from an insecure file.
                        match load_config(&params, true) {
                            Ok(new_config) => {
                                *(config.write().await) = new_config;
                                let _ = tx2.send(());
                                info!("Reloaded config");
                            }
                            Err(error) => error!(?error, "Failed to reload config"),
                        }
                    }
                }
                Some(Err(error)) => error!(?error, "Failed to watch config"),
                None => {
                    error!("Config watch failed");
                    break;
                }
            }
        }

        #[allow(unreachable_code)]
        Ok::<_, anyhow::Error>(())
    });

    Ok(rx2)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parse_yaml(yaml: &str) -> Result<GatedConfigStore> {
        parse_config_store(
            Config::builder()
                .add_source(File::from_str(yaml, FileFormat::Yaml))
                .build()?,
        )
    }

    #[test]
    fn migration_renames_web_admin_and_splits_require_lists() {
        let mut store = json!({
            "web_admin": { "listen": "0.0.0.0:8888" },
            "users": [
                { "username": "a", "require": ["password", "otp"] },
                { "username": "b", "require": { "ssh": ["publickey"] } },
                { "username": "c" },
            ],
        });

        check_and_migrate_config(&mut store);

        assert_eq!(
            store,
            json!({
                "http": { "listen": "0.0.0.0:8888" },
                "users": [
                    {
                        "username": "a",
                        "require": { "ssh": ["password", "otp"], "http": ["password", "otp"] },
                    },
                    { "username": "b", "require": { "ssh": ["publickey"] } },
                    { "username": "c" },
                ],
            })
        );
    }

    #[test]
    fn deprecated_web_admin_section_configures_http() {
        let store = parse_yaml("web_admin:\n  listen: 127.0.0.1:9999\n").expect("parse config");

        assert_eq!(store.http.listen.port(), 9999);
    }

    #[test]
    fn serialized_store_parses_back_unchanged() {
        let mut store = GatedConfigStore {
            external_host: Some("gated.example.com".to_owned()),
            ..Default::default()
        };
        store.ssh.enable = true;
        store.recordings.enable = true;

        let yaml = serialize_config_store(&store).expect("serialize config");
        let parsed = parse_yaml(&yaml).expect("parse serialized config");

        assert_eq!(
            serde_json::to_value(&parsed).expect("parsed as json"),
            serde_json::to_value(&store).expect("store as json"),
        );
    }
}
