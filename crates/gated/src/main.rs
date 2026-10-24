#![forbid(unsafe_code)]
mod commands;
mod config;
mod logging;

use std::path::PathBuf;

use anyhow::Result;
use clap::{ArgAction, Parser};
use gated_common::version::gated_version;
use gated_common::{GlobalParams, LogFormat, Secret};
use logging::init_logging;
use tracing::*;

use crate::config::load_config;

#[derive(clap::Parser)]
#[clap(author, about, long_about = None)]
pub struct Cli {
    #[clap(subcommand)]
    command: Commands,

    #[clap(long, short, default_value = "/etc/gated.yaml", action=ArgAction::Set, env="GATED_CONFIG")]
    config: PathBuf,

    #[clap(long, short, action=ArgAction::Count)]
    debug: u8,

    /// Log output format (text or json)
    #[clap(long, value_enum)]
    log_format: Option<LogFormat>,

    /// Do not tighten UNIX modes of config and data files
    #[clap(long)]
    skip_securing_files: bool,
}

impl Cli {
    #[allow(clippy::wrong_self_convention)]
    pub fn into_global_params(&self) -> anyhow::Result<GlobalParams> {
        gated_common::GlobalParams::new(self.config.clone(), !self.skip_securing_files)
    }
}

#[derive(clap::Subcommand)]
pub(crate) enum Commands {
    /// Run first-time setup and generate a config file
    Setup {
        /// Database URL
        #[clap(long)]
        database_url: Option<String>,

        /// Username for the initial admin user. If omitted, you will be
        /// prompted (default: `admin`).
        #[clap(long)]
        admin_username: Option<String>,
    },
    /// Run first-time setup non-interactively
    UnattendedSetup {
        /// Database URL
        #[clap(long)]
        database_url: Option<String>,

        /// Username for the initial admin user. Falls back to
        /// `GATED_ADMIN_USERNAME`, then to `admin`.
        #[clap(long, env = "GATED_ADMIN_USERNAME")]
        admin_username: Option<String>,

        /// Directory to store data in
        #[clap(long)]
        data_path: String,

        /// Admin UI/API port
        #[clap(long)]
        admin_port: u16,

        /// Enable SSH and set port
        #[clap(long)]
        ssh_port: Option<u16>,

        /// Enable MySQL and set port
        #[clap(long)]
        mysql_port: Option<u16>,

        /// Enable PostgreSQL and set port
        #[clap(long)]
        postgres_port: Option<u16>,

        /// Enable Kubernetes and set port
        #[clap(long)]
        kubernetes_port: Option<u16>,

        /// Enable session recording
        #[clap(long)]
        record_sessions: bool,

        /// Password for the initial user (required if GATED_ADMIN_PASSWORD env var is not set)
        #[clap(long)]
        admin_password: Option<String>,

        /// External host used to construct URLs (without a port or scheme)
        #[clap(long)]
        external_host: Option<String>,
    },
    /// Show Gated's SSH client keys
    ClientKeys,
    /// Run Gated
    Run {
        /// Enable an API token (passed via the `GATED_ADMIN_TOKEN` env var) that automatically maps to the first admin user
        #[clap(long, action=ArgAction::SetTrue)]
        enable_admin_token: bool,
        /// Override the admin listen port from the config file. Bind address
        /// (`admin.listen` IP) is preserved; only the port changes. Pass the
        /// literal `NSL_PORT` when launching via `nsl run`.
        #[clap(long)]
        admin_port: Option<u16>,
    },
    /// Perform basic config checks
    Check,
    /// Create a new user
    CreateUser {
        #[clap(action=ArgAction::Set)]
        username: String,
        /// Password (required if GATED_NEW_USER_PASSWORD env var is not set)
        #[clap(short, long, action=ArgAction::Set)]
        password: Option<String>,
        #[clap(short, long, action=ArgAction::Set)]
        role: Option<String>,
    },
    /// Reset password and auth policy for a user
    RecoverAccess {
        #[clap(action=ArgAction::Set)]
        username: Option<String>,
    },
    /// Show version information
    Version,
    /// Automatic healthcheck for running Gated in a container.
    ///
    /// Without `--deep`, this performs a basic HTTP liveness check
    /// against the admin API. With `--deep`, it builds a full `Services`
    /// context and reports DB connectivity, migration status, a R/W
    /// probe, TLS certificate validity, and SSO reachability as
    /// JSON. Exits non-zero if the overall status is not `ok`.
    Healthcheck {
        /// Run deep checks (DB ping, migrations, tx commit, TLS cert,
        /// SSO). Output is a JSON report on stdout.
        #[clap(long, action)]
        deep: bool,
        /// With `--deep`, skip remote-system probes (SSO). Local
        /// checks still run. Useful in CI / bootstrap contexts where
        /// the identity providers aren't reachable yet.
        #[clap(long, action)]
        skip_lookups: bool,
    },
    /// Encrypt an existing plaintext sqlite database in place.
    EncryptExistingDb {
        /// Delete db.sqlite3.plain.bak after a successful migration.
        #[clap(long, action)]
        auto_delete_plaintext: bool,
        /// Override the data directory used for sqlite DB and encryption metadata.
        #[clap(long)]
        data_dir: Option<PathBuf>,
        /// Master password used to initialize encryption.
        #[clap(long, env = "GATED_ENCRYPT_MASTER_PASSWORD")]
        master_password: Option<String>,
    },
}

async fn _main() -> Result<()> {
    let cli = Cli::parse();
    let params = cli.into_global_params()?;

    let logging_guards = init_logging(load_config(&params, false).ok().as_ref(), &cli).await?;

    #[allow(
        clippy::unwrap_used,
        reason = "install_default only fails if called twice; we call it once at startup"
    )]
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .unwrap();

    let result = match &cli.command {
        Commands::Version => {
            println!("gated {}", gated_version());
            Ok(())
        }
        Commands::Run {
            enable_admin_token,
            admin_port,
        } => crate::commands::run::command(&params, *enable_admin_token, *admin_port).await,
        Commands::Check => crate::commands::check::command(&params).await,
        Commands::CreateUser {
            username,
            password: explicit_password,
            role,
        } => {
            #[allow(clippy::collapsible_else_if)]
            let password = if let Some(p) = explicit_password {
                p.to_owned()
            } else {
                if let Ok(p) = std::env::var("GATED_NEW_USER_PASSWORD") {
                    p
                } else {
                    error!("You must supply the password either through the --password option");
                    error!("or the GATED_NEW_USER_PASSWORD environment variable.");
                    std::process::exit(1);
                }
            };

            crate::commands::create_user::command(
                &params,
                username,
                &Secret::new(password.clone()),
                role,
            )
            .await
        }
        Commands::Setup { .. } | Commands::UnattendedSetup { .. } => {
            crate::commands::setup::command(&cli, &params).await
        }
        Commands::ClientKeys => crate::commands::client_keys::command(&params).await,
        Commands::RecoverAccess { username } => {
            crate::commands::recover_access::command(&params, username).await
        }
        Commands::Healthcheck { deep, skip_lookups } => {
            crate::commands::healthcheck::command(&params, *deep, *skip_lookups).await
        }
        Commands::EncryptExistingDb {
            auto_delete_plaintext,
            data_dir,
            master_password,
        } => {
            crate::commands::encrypt_existing_db::command(
                &params,
                *auto_delete_plaintext,
                data_dir.clone(),
                master_password.clone(),
            )
            .await
        }
    };

    logging_guards.shutdown();
    result
}

#[tokio::main]
async fn main() {
    // A core dump would write secrets held in memory to disk.
    let _ = rlimit::setrlimit(rlimit::Resource::CORE, 0, 0);

    // On panic: report the error and exit cleanly (no core dump)
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::capture();
        eprintln!("fatal: {info}");
        error!(panic = %info, %backtrace, "Fatal panic");
        std::process::exit(1);
    }));

    if let Err(error) = _main().await {
        error!(?error, "Fatal error");
        std::process::exit(1);
    }
}
