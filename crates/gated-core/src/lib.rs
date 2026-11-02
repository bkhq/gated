#![forbid(unsafe_code)]
pub mod account_credentials;
mod auth_state_store;
pub mod command_acl;
pub mod command_acl_loader;
mod config_providers;
pub mod consts;
mod data;
pub mod db;
pub mod db_pool_registry;
pub mod encryption;
pub mod healthcheck;
pub mod lode;
pub mod logging;
pub mod metrics;
mod protocols;
pub mod rate_limiting;
pub mod recordings;
mod services;
pub mod sql_console_rate_limit;
mod state;
pub use auth_state_store::*;
pub use config_providers::*;
pub use data::*;
pub use protocols::*;
pub use services::*;
pub use sql_console_rate_limit::{SqlConsoleRateLimitError, SqlConsoleRateLimiter};
pub use state::{SessionState, SessionStateInit, State};

/// Persist a security event; ordinary tracing output is observability only.
#[macro_export]
macro_rules! audit {
    ($($arg:tt)*) => { ::tracing::info!(target: "audit", $($arg)*) };
}
