#![allow(clippy::collapsible_else_if)]

use std::fs::{File, create_dir_all};
use std::io::Write;
use std::net::{Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use dialoguer::theme::ColorfulTheme;
use gated_common::helpers::fs::{secure_directory, secure_file};
use gated_common::version::gated_version;
use gated_common::{
    AdminConfig, GatedConfigStore, GlobalParams, HttpConfig, ListenEndpoint, MySqlConfig,
    PostgresConfig, Secret, SshConfig,
};
use rcgen::generate_simple_self_signed;
use tracing::*;

use crate::Commands;
use crate::commands::common::{assert_interactive_terminal, is_docker};
use crate::config::load_config;

fn prompt_endpoint(prompt: &str, default: ListenEndpoint) -> ListenEndpoint {
    loop {
        let v = dialoguer::Input::with_theme(&ColorfulTheme::default())
            .default(format!("{default:?}"))
            .with_prompt(prompt)
            .interact_text()
            .context("dialoguer")
            .and_then(|v| v.to_socket_addrs().context("address resolution"));
        match v {
            Ok(mut addr) => match addr.next() {
                Some(addr) => return ListenEndpoint::from(addr),
                None => {
                    error!("No endpoints resolved");
                }
            },
            Err(err) => {
                error!("Failed to resolve this endpoint: {err}")
            }
        }
    }
}

pub(crate) async fn command(command: &Commands, params: &GlobalParams) -> Result<()> {
    initialize(command, params).await?;
    let config_path = params.config_path();
    info!("");
    info!("You can now start Gated with:");
    if is_docker() {
        info!(
            "docker run -p 8888:8888 -p 2222:2222 -it -v <your data dir>:/data ghcr.io/bkhq/gated"
        );
    } else {
        let (flag, path) = if params.has_data_dir() {
            ("--data-dir", params.data_dir())
        } else {
            ("--config", config_path.clone())
        };
        info!(
            "  {} {flag} {} run",
            std::env::args()
                .next()
                .unwrap_or_else(|| "gated".to_string()),
            path.display()
        );
    }
    info!("then open the admin UI to create the first admin account.");

    Ok(())
}

/// Writes the config and the TLS certificate. The first admin account and
/// the SSH keys are created by setup in the admin UI.
async fn initialize(command: &Commands, params: &GlobalParams) -> Result<()> {
    let version = gated_version();
    info!("Welcome to Gated {version}");

    let config_path = params.config_path();
    if config_path.exists() {
        error!("Config file already exists at {}.", config_path.display());
        error!("To generate a new config file, rename or delete the existing one first.");
        std::process::exit(1);
    }

    if let Commands::Setup { .. } = command {
        assert_interactive_terminal();
    }

    let mut config_dir = config_path.parent().unwrap_or_else(|| Path::new(&"."));
    if config_dir.as_os_str().is_empty() {
        config_dir = Path::new(&".");
    }
    create_dir_all(config_dir)?;

    info!("Let's do some basic setup first.");
    info!(
        "The new config will be written in {}.",
        config_path.display()
    );

    let theme = ColorfulTheme::default();
    let mut store = GatedConfigStore::default();

    // ---

    if !is_docker() && !params.has_data_dir() {
        info!(
            "* Paths can be either absolute or relative to {}.",
            config_dir.canonicalize()?.display()
        );
    }

    // ---

    let data_path: String = if params.has_data_dir() {
        params.data_dir().to_string_lossy().to_string()
    } else if let Commands::UnattendedSetup { data_path, .. } = command {
        let Some(data_path) = data_path else {
            error!("Pass --data-path, or the global --data-dir.");
            std::process::exit(1);
        };
        data_path.to_owned()
    } else {
        #[cfg(target_os = "linux")]
        let default_data_path = "/var/lib/gated".to_string();
        #[cfg(target_os = "macos")]
        let default_data_path = "/usr/local/var/lib/gated".to_string();

        if is_docker() {
            "/data".to_owned()
        } else {
            dialoguer::Input::with_theme(&theme)
                .default(default_data_path)
                .with_prompt("Directory to store app data (up to a few MB) in")
                .interact_text()?
        }
    };

    let data_path = config_dir.join(PathBuf::from(&data_path));
    create_dir_all(&data_path)?;
    let data_path = data_path.canonicalize()?;
    // With --data-dir the config stores paths relative to it, so the whole
    // directory can be moved or restored elsewhere.
    let stored_path = |name: &str| -> String {
        if params.has_data_dir() {
            name.to_owned()
        } else {
            data_path.join(name).to_string_lossy().to_string()
        }
    };

    let db_path = data_path.join("db");
    create_dir_all(&db_path)?;
    if params.should_secure_files() {
        secure_directory(&db_path)?;
    }

    store.database_url = Secret::new(match command {
        Commands::UnattendedSetup {
            database_url: Some(url),
            ..
        }
        | Commands::Setup {
            database_url: Some(url),
            ..
        } => url.to_owned(),
        _ => {
            let mut db_path = stored_path("db");

            if let Some(x) = db_path.strip_suffix("./") {
                db_path = x.to_string();
            }

            format!("sqlite:{db_path}")
        }
    });

    if let Commands::UnattendedSetup { admin_port, .. } = command {
        store.admin.listen =
            ListenEndpoint::from(SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), *admin_port));
    } else {
        if !is_docker() {
            store.admin.listen = prompt_endpoint(
                "Endpoint to listen for admin UI/API connections on",
                AdminConfig::default().listen,
            );
        }
    }

    if let Commands::UnattendedSetup { ssh_port, .. } = command {
        if let Some(ssh_port) = ssh_port {
            store.ssh.enable = true;
            store.ssh.listen =
                ListenEndpoint::from(SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), *ssh_port));
        }
    } else {
        if is_docker() {
            store.ssh.enable = true;
        } else {
            info!("You will now choose specific protocol listeners to be enabled.");
            info!("");
            info!("NB: Nothing will be exposed by default -");
            info!("    you'll choose target hosts in the UI later.");

            store.ssh.enable = dialoguer::Confirm::with_theme(&theme)
                .default(true)
                .with_prompt("Accept SSH connections?")
                .interact()?;

            if store.ssh.enable {
                store.ssh.listen = prompt_endpoint(
                    "Endpoint to listen for SSH connections on",
                    SshConfig::default().listen,
                );
            }
        }
    }

    if let Commands::UnattendedSetup { mysql_port, .. } = command {
        if let Some(mysql_port) = mysql_port {
            store.mysql.enable = true;
            store.mysql.listen =
                ListenEndpoint::from(SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), *mysql_port));
        }
    } else {
        if is_docker() {
            store.mysql.enable = true;
        } else {
            store.mysql.enable = dialoguer::Confirm::with_theme(&theme)
                .default(true)
                .with_prompt("Accept MySQL connections?")
                .interact()?;

            if store.mysql.enable {
                store.mysql.listen = prompt_endpoint(
                    "Endpoint to listen for MySQL connections on",
                    MySqlConfig::default().listen,
                );
            }
        }
    }

    if let Commands::UnattendedSetup { postgres_port, .. } = command {
        if let Some(postgres_port) = postgres_port {
            store.postgres.enable = true;
            store.postgres.listen = ListenEndpoint::from(SocketAddr::new(
                Ipv6Addr::UNSPECIFIED.into(),
                *postgres_port,
            ));
        }
    } else {
        if is_docker() {
            store.postgres.enable = true;
        } else {
            store.postgres.enable = dialoguer::Confirm::with_theme(&theme)
                .default(true)
                .with_prompt("Accept PostgreSQL connections?")
                .interact()?;

            if store.postgres.enable {
                store.postgres.listen = prompt_endpoint(
                    "Endpoint to listen for PostgreSQL connections on",
                    PostgresConfig::default().listen,
                );
            }
        }
    }

    if let Commands::UnattendedSetup { http_port, .. } = command {
        if let Some(http_port) = http_port {
            store.http.enable = true;
            store.http.listen =
                ListenEndpoint::from(SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), *http_port));
        }
    } else {
        if is_docker() {
            store.http.enable = true;
        } else {
            store.http.enable = dialoguer::Confirm::with_theme(&theme)
                .default(true)
                .with_prompt("Accept HTTP proxy connections?")
                .interact()?;

            if store.http.enable {
                store.http.listen = prompt_endpoint(
                    "Endpoint to listen for HTTP proxy connections on",
                    HttpConfig::default().listen,
                );
            }
        }
    }

    store.admin.certificate = stored_path("tls.certificate.pem");

    store.admin.key = stored_path("tls.key.pem");

    store.mysql.certificate = store.admin.certificate.clone();
    store.mysql.key = store.admin.key.clone();

    store.postgres.certificate = store.admin.certificate.clone();
    store.postgres.key = store.admin.key.clone();

    store.http.certificate = store.admin.certificate.clone();
    store.http.key = store.admin.key.clone();

    // ---

    if let Commands::UnattendedSetup {
        record_sessions, ..
    } = command
    {
        store.recordings.enable = *record_sessions;
    } else {
        store.recordings.enable = dialoguer::Confirm::with_theme(&theme)
            .default(true)
            .with_prompt("Do you want to record user sessions?")
            .interact()?;
    }
    store.recordings.path = stored_path("recordings");

    // ---

    store.encryption.enable = if let Commands::UnattendedSetup { encryption, .. } = command {
        *encryption
    } else {
        dialoguer::Confirm::with_theme(&theme)
            .default(false)
            .with_prompt("Encrypt the database at rest?")
            .interact()?
    };

    if let Commands::UnattendedSetup { external_host, .. } = command {
        store.external_host = external_host.clone();
    }

    // ---

    // The generated config contains secrets (e.g. `database_url`).
    // Do not dump it to stdout; it is written to the secured config file below.
    let yaml = crate::config::serialize_config_store(&store)?;

    let yaml = format!(
        "# Config generated in version {version}\n# yaml-language-server: $schema=https://raw.githubusercontent.com/bkhq/gated/refs/heads/main/config-schema.json\n\n{yaml}",
        version = gated_version()
    );

    File::create(config_path)?.write_all(yaml.as_bytes())?;
    info!("Saved into {}", config_path.display());

    let config = load_config(params, true)?;

    {
        info!("Generating a TLS certificate");
        let cert =
            generate_simple_self_signed(vec!["gated.local".to_string(), "localhost".to_string()])?;

        let certificate_path = params
            .paths_relative_to()
            .join(&config.store.admin.certificate);
        let key_path = params.paths_relative_to().join(&config.store.admin.key);
        std::fs::write(&certificate_path, cert.cert.pem())?;
        std::fs::write(&key_path, cert.key_pair.serialize_pem())?;
        if params.should_secure_files() {
            secure_file(&certificate_path)?;
            secure_file(&key_path)?;
        }
    }

    Ok(())
}

/// Writes a default config into an empty `--data-dir`, so a fresh container
/// starts without a separate setup step. `GATED_ENCRYPTION` turns on
/// at-rest encryption.
pub(crate) async fn first_start(params: &GlobalParams, admin_port: Option<u16>) -> Result<()> {
    info!("No config file found, running first-start setup");

    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let ssh_port = match env("GATED_SSH_PORT") {
        Some(port) => port.parse().context("GATED_SSH_PORT")?,
        None => SshConfig::default().listen.port(),
    };
    let http_port = match env("GATED_HTTP_PORT") {
        Some(port) => port.parse().context("GATED_HTTP_PORT")?,
        None => HttpConfig::default().listen.port(),
    };
    let encryption = env("GATED_ENCRYPTION").is_some_and(|v| {
        !matches!(
            v.to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        )
    });

    initialize(
        &Commands::UnattendedSetup {
            database_url: None,
            data_path: None,
            admin_port: admin_port.unwrap_or_else(|| AdminConfig::default().listen.port()),
            ssh_port: Some(ssh_port),
            mysql_port: None,
            postgres_port: None,
            http_port: Some(http_port),
            record_sessions: true,
            encryption,
            external_host: env("GATED_EXTERNAL_HOST"),
        },
        params,
    )
    .await
}
