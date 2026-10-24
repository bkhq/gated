use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use arc_swap::ArcSwapOption;
use gated_common::{GatedConfig, GlobalParams};
use gated_db_migrations::migrate_database;
use sea_orm::{Database, DatabaseConnection};
use tokio::sync::{Mutex, Notify, RwLock};

use crate::ConfigProvider;
use crate::db::{connect_to_db, make_sqlcipher_connect_options, populate_db};
use crate::db_pool_registry::DbPoolRegistry;
use crate::encryption::{BootstrapToken, EncryptionRuntime};
use crate::metrics::MetricsHandle;
use crate::rate_limiting::RateLimiterRegistry;
use crate::recordings::SessionRecordings;
use crate::sql_console_rate_limit::SqlConsoleRateLimiter;
use crate::{
    AuthStateStore, CommandReviewStore, ConfigProviderEnum, DatabaseConfigProvider, State,
};

/// Shared runtime state of a running gateway. Per-field synchronization:
///
/// - `db`, `config`, `state`, `config_provider`, `auth_state_store`:
///   read-heavy or pure-read in hot paths, so `RwLock` lets concurrent
///   requests share a reader lock instead of serialising through one
///   `Mutex`.
/// - `admin_token`: read-only once set (no reload path); using
///   `ArcSwapOption` makes the read a lock-free atomic load.
/// - `recordings`, `rate_limiter_registry`: currently have balanced
///   read/write patterns (or all writes), so they stay on `Mutex`.
/// - `sql_console_rate_limiter`: already built around a lock-free
///   governor cell.
pub type SharedDatabaseConnection = Arc<RwLock<Option<DatabaseConnection>>>;

#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("database is locked")]
pub struct DbLockedError;

pub async fn db_required(
    db: &SharedDatabaseConnection,
) -> std::result::Result<DatabaseConnection, DbLockedError> {
    db.read().await.as_ref().cloned().ok_or(DbLockedError)
}

impl From<DbLockedError> for gated_common::GatedError {
    fn from(value: DbLockedError) -> Self {
        Self::other(value)
    }
}

impl axum::response::IntoResponse for DbLockedError {
    fn into_response(self) -> axum::response::Response {
        (axum::http::StatusCode::LOCKED, self.to_string()).into_response()
    }
}

#[derive(Clone)]
pub struct Services {
    pub db: SharedDatabaseConnection,
    pub recordings: Arc<Mutex<SessionRecordings>>,
    pub config: Arc<RwLock<GatedConfig>>,
    pub state: Arc<RwLock<State>>,
    pub config_provider: Arc<Mutex<ConfigProviderEnum>>,
    pub auth_state_store: Arc<Mutex<AuthStateStore>>,
    /// Command reviews paused awaiting an admin approve/reject.
    /// Empty unless an `action=review` command-ACL rule matches.
    pub command_review_store: Arc<Mutex<CommandReviewStore>>,
    pub admin_token: Arc<ArcSwapOption<String>>,
    pub rate_limiter_registry: Arc<Mutex<RateLimiterRegistry>>,
    pub sql_console_rate_limiter: Arc<SqlConsoleRateLimiter>,
    /// Per-target sqlx connection pool cache for the SQL Console. See
    /// [`DbPoolRegistry`] for invalidation semantics.
    pub db_pool_registry: Arc<DbPoolRegistry>,
    /// `Some` when `metrics.enable = true` and the global Prometheus
    /// recorder was installed at startup. The handle is used by the
    /// metrics HTTP listener to render the current snapshot.
    pub metrics: Option<Arc<MetricsHandle>>,
    pub global_params: Arc<GlobalParams>,
    pub encryption_runtime: Arc<RwLock<Option<Arc<EncryptionRuntime>>>>,
    pub encryption_bootstrap_token: Arc<RwLock<Option<Arc<BootstrapToken>>>>,
    pub encryption_notify: Arc<Notify>,
    /// Signalled after user, role or target changes that can revoke access,
    /// so live sessions are re-authorized without waiting for a config reload.
    pub authorization_changed: Arc<Notify>,
}

impl Services {
    pub async fn db_required(&self) -> std::result::Result<DatabaseConnection, DbLockedError> {
        db_required(&self.db).await
    }

    pub async fn new(
        config: GatedConfig,
        admin_token: Option<String>,
        params: GlobalParams,
        metrics: Option<Arc<MetricsHandle>>,
    ) -> Result<Self> {
        let db = Arc::new(RwLock::new(None));

        let recordings = SessionRecordings::new(db.clone(), &config, &params)?;
        let recordings = Arc::new(Mutex::new(recordings));

        let config = Arc::new(RwLock::new(config));

        let config_provider = Arc::new(Mutex::new(DatabaseConfigProvider::new(&db).await.into()));

        let auth_state_store = Arc::new(Mutex::new(AuthStateStore::new(config_provider.clone())));

        tokio::spawn({
            let auth_state_store = auth_state_store.clone();
            async move {
                loop {
                    auth_state_store.lock().await.vacuum().await;
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
        });

        let command_review_store = Arc::new(Mutex::new(CommandReviewStore::new()));

        tokio::spawn({
            let command_review_store = command_review_store.clone();
            async move {
                loop {
                    command_review_store.lock().await.vacuum();
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
        });

        let rate_limiter_registry = RateLimiterRegistry::new(db.clone());
        let rate_limiter_registry = Arc::new(Mutex::new(rate_limiter_registry));

        let sql_console_rate_limiter = Arc::new(SqlConsoleRateLimiter::new());
        let db_pool_registry = DbPoolRegistry::new();

        Ok(Self {
            db: db.clone(),
            recordings,
            config: config.clone(),
            state: State::new(&db, &rate_limiter_registry)?,
            rate_limiter_registry,
            sql_console_rate_limiter,
            db_pool_registry,
            config_provider,
            auth_state_store,
            command_review_store,
            admin_token: Arc::new(ArcSwapOption::new(admin_token.map(Arc::new))),
            metrics,
            global_params: Arc::new(params),
            encryption_runtime: Arc::new(RwLock::new(None)),
            encryption_bootstrap_token: Arc::new(RwLock::new(None)),
            encryption_notify: Arc::new(Notify::new()),
            authorization_changed: Arc::new(Notify::new()),
        })
    }

    pub async fn set_encryption_runtime(&self, runtime: Arc<EncryptionRuntime>) {
        *self.encryption_runtime.write().await = Some(runtime);
    }

    pub async fn set_encryption_bootstrap_token(&self, token: Option<BootstrapToken>) {
        *self.encryption_bootstrap_token.write().await = token.map(Arc::new);
    }

    pub async fn clear_encryption_bootstrap_token(&self) -> Result<()> {
        let token = self.encryption_bootstrap_token.write().await.take();
        if let Some(token) = token {
            token.delete_file().await?;
        }
        Ok(())
    }

    /// Request a re-authorization pass over live sessions.
    pub fn notify_authorization_changed(&self) {
        self.authorization_changed.notify_one();
    }

    /// Close every live session whose user is no longer authorized for its
    /// target. A session whose check fails with an error is left open and
    /// logged. Returns the number of sessions closed.
    /// Closes live sessions and waits, up to `timeout` in total, for them to
    /// deregister and for their recordings to reach the disk.
    pub async fn shutdown(&self, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;

        let remaining = State::close_all_sessions(&self.state, timeout).await;
        if remaining > 0 {
            tracing::warn!(remaining, "Sessions still open at shutdown");
        }

        let mut writers = self.recordings.lock().await.active_writers();
        if tokio::time::timeout_at(deadline, writers.wait_for(|count| *count == 0))
            .await
            .is_err()
        {
            tracing::warn!("Recordings still being written at shutdown");
        }
    }

    pub async fn revalidate_sessions(&self) -> usize {
        let state = self.state.read().await;
        let mut config_provider = self.config_provider.lock().await;
        let mut closed = 0;
        for (id, session) in state.sessions.iter() {
            let mut session = session.lock().await;
            let (Some(user_info), Some(target)) =
                (session.user_info.as_ref(), session.target.as_ref())
            else {
                continue;
            };
            match config_provider
                .authorize_target(&user_info.username, &target.name)
                .await
            {
                Ok(true) => {}
                Ok(false) => {
                    tracing::warn!(session_id = %id, username = %user_info.username, target = %target.name, "Session no longer authorized, closing");
                    session.handle.close();
                    closed += 1;
                }
                Err(error) => {
                    tracing::error!(session_id = %id, ?error, "Failed to re-authorize session");
                }
            }
        }
        closed
    }

    pub async fn notify_unlocked(&self) {
        self.encryption_notify.notify_waiters();
    }

    pub async fn open_db_legacy(&self) -> Result<()> {
        let mut config = self.config.write().await;
        let mut connection = connect_to_db(&config, &self.global_params).await?;
        populate_db(&mut connection, &mut config).await?;
        *self.db.write().await = Some(connection);
        drop(config);
        self.refresh_db_dependents().await
    }

    pub async fn open_db(&self, dek_hex: &str) -> Result<()> {
        let mut config = self.config.write().await;
        let encrypted = make_sqlcipher_connect_options(&config, &self.global_params, dek_hex)
            .await
            .context("building SQLCipher connect options")?;
        let mut connection = Database::connect(encrypted)
            .await
            .context("opening encrypted database")?;
        migrate_database(&connection).await?;
        populate_db(&mut connection, &mut config).await?;
        *self.db.write().await = Some(connection);
        drop(config);
        self.refresh_db_dependents().await
    }

    pub async fn close_db(&self) {
        let connection = self.db.write().await.take();
        self.db_pool_registry.clear_all().await;
        if let Some(connection) = connection {
            let _ = connection.close().await;
        }
    }

    async fn refresh_db_dependents(&self) -> Result<()> {
        self.rate_limiter_registry.lock().await.refresh().await?;
        self.sql_console_rate_limiter.refresh(&self.db).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use gated_common::Secret;
    use uuid::Uuid;

    use super::*;

    fn test_params(name: &str) -> (GatedConfig, GlobalParams) {
        let root = std::env::temp_dir().join(format!("gated-services-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").unwrap();
        let mut config = GatedConfig {
            store: Default::default(),
        };
        config.store.database_url = Secret::new("sqlite:data/db".to_owned());
        let params = GlobalParams::new(config_path, false).unwrap();
        (config, params)
    }

    #[tokio::test]
    async fn db_required_errors_before_open() {
        let (config, params) = test_params("locked");
        let services = Services::new(config, None, params, None).await.unwrap();

        assert!(services.db_required().await.is_err());
    }

    #[tokio::test]
    async fn open_and_close_legacy_db_updates_availability() {
        let (config, params) = test_params("open-close");
        let services = Services::new(config, None, params, None).await.unwrap();

        services.open_db_legacy().await.unwrap();
        assert!(services.db_required().await.is_ok());

        services.close_db().await;
        assert!(services.db_required().await.is_err());
    }
}

#[cfg(all(test, feature = "sqlite"))]
mod revalidation_tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use gated_common::auth::AuthStateUserInfo;
    use gated_common::{GatedConfig, GlobalParams, Target, TargetMySqlOptions, TargetOptions, Tls};
    use gated_db_entities as entities;
    use gated_tls::TlsMode;
    use sea_orm::{ActiveModelTrait, Set};
    use uuid::Uuid;

    use super::*;
    use crate::state::SessionState;
    use crate::{SessionHandle, SessionStateInit};

    struct FlagHandle(Arc<AtomicBool>);

    impl SessionHandle for FlagHandle {
        fn close(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn target(name: &str) -> Target {
        Target {
            id: Uuid::new_v4(),
            name: name.into(),
            description: String::new(),
            allow_roles: vec![],
            group_id: None,
            rate_limit_bytes_per_second: None,
            options: TargetOptions::MySql(TargetMySqlOptions {
                host: "localhost".into(),
                port: 3306,
                username: "u".into(),
                password: None,
                default_database_name: None,
                tls: Tls {
                    mode: TlsMode::Disabled,
                    verify: false,
                },
                readonly: false,
            }),
            accounts: vec![],
        }
    }

    async fn insert_session(
        services: &Services,
        username: &str,
        target_name: &str,
    ) -> Arc<AtomicBool> {
        let closed = Arc::new(AtomicBool::new(false));
        let (sender, _) = tokio::sync::broadcast::channel(1);
        let mut session = SessionState::new(
            SessionStateInit {
                remote_address: None,
                handle: Box::new(FlagHandle(closed.clone())),
            },
            sender,
            "MySQL",
        );
        session.user_info = Some(AuthStateUserInfo {
            id: Uuid::new_v4(),
            username: username.into(),
        });
        session.target = Some(target(target_name));
        services
            .state
            .write()
            .await
            .sessions
            .insert(Uuid::new_v4(), Arc::new(Mutex::new(session)));
        closed
    }

    #[tokio::test]
    async fn revalidation_closes_only_sessions_that_lost_authorization() {
        let root = std::env::temp_dir().join(format!("gated-revalidate-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").expect("write config");
        let params = GlobalParams::new(config_path, false).expect("global params");
        let config = GatedConfig {
            store: Default::default(),
        };
        let services = Services::new(config, None, params, None)
            .await
            .expect("services");

        let conn = Database::connect("sqlite::memory:").await.expect("connect");
        migrate_database(&conn).await.expect("migrate");
        let role_id = Uuid::new_v4();
        entities::Role::ActiveModel {
            id: Set(role_id),
            name: Set("ops".into()),
            description: Set(String::new()),
            allow_file_transfer: Set(true),
        }
        .insert(&conn)
        .await
        .expect("role");
        let target_id = Uuid::new_v4();
        entities::Target::ActiveModel {
            id: Set(target_id),
            name: Set("db".into()),
            description: Set(String::new()),
            kind: Set(entities::Target::TargetKind::MySql),
            options: Set(serde_json::to_value(target("db").options).expect("options")),
            rate_limit_bytes_per_second: Set(None),
            group_id: Set(None),
        }
        .insert(&conn)
        .await
        .expect("target");
        entities::TargetRoleAssignment::ActiveModel {
            target_id: Set(target_id),
            role_id: Set(role_id),
            ..Default::default()
        }
        .insert(&conn)
        .await
        .expect("target role");
        for (name, with_role) in [("alice", true), ("bob", false)] {
            let user_id = Uuid::new_v4();
            entities::User::ActiveModel {
                id: Set(user_id),
                username: Set(name.into()),
                description: Set(String::new()),
                credential_policy: Set(serde_json::json!({})),
                rate_limit_bytes_per_second: Set(None),
            }
            .insert(&conn)
            .await
            .expect("user");
            if with_role {
                entities::UserRoleAssignment::ActiveModel {
                    user_id: Set(user_id),
                    role_id: Set(role_id),
                    ..Default::default()
                }
                .insert(&conn)
                .await
                .expect("user role");
            }
        }
        *services.db.write().await = Some(conn);

        let alice = insert_session(&services, "alice", "db").await;
        let bob = insert_session(&services, "bob", "db").await;

        assert_eq!(services.revalidate_sessions().await, 1);
        assert!(!alice.load(Ordering::SeqCst));
        assert!(bob.load(Ordering::SeqCst));
    }
}

#[cfg(test)]
#[cfg(feature = "sqlite")]
mod shutdown_tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use gated_common::Secret;
    use gated_common::auth::AuthStateUserInfo;
    use gated_db_entities::{Recording, Session};
    use sea_orm::EntityTrait;
    use uuid::Uuid;

    use super::*;
    use crate::recordings::{TerminalRecorder, TerminalRecordingStreamId};
    use crate::{GatedServerHandle, SessionHandle, SessionStateInit};

    struct FlagHandle(Arc<AtomicBool>);

    impl SessionHandle for FlagHandle {
        fn close(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    async fn services_with_recordings() -> Services {
        let root = std::env::temp_dir().join(format!("gated-shutdown-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").expect("write config");
        let mut config = GatedConfig {
            store: Default::default(),
        };
        config.store.database_url = Secret::new("sqlite:data/db".to_owned());
        config.store.recordings.enable = true;
        let params = GlobalParams::new(config_path, false).expect("global params");
        let services = Services::new(config, None, params, None)
            .await
            .expect("services");
        services.open_db_legacy().await.expect("open db");
        services
    }

    /// The session stays registered until the returned handle is dropped.
    async fn register_session(
        services: &Services,
    ) -> (Arc<Mutex<GatedServerHandle>>, Arc<AtomicBool>) {
        let closed = Arc::new(AtomicBool::new(false));
        let handle = State::register_session(
            &services.state,
            &"SSH",
            SessionStateInit {
                remote_address: None,
                handle: Box::new(FlagHandle(closed.clone())),
            },
        )
        .await
        .expect("register session");
        (handle, closed)
    }

    #[tokio::test]
    async fn shutdown_closes_sessions_and_flushes_recordings() {
        let services = services_with_recordings().await;
        let (handle, closed) = register_session(&services).await;
        let id = handle.lock().await.id();
        handle
            .lock()
            .await
            .set_user_info(AuthStateUserInfo {
                id: Uuid::new_v4(),
                username: "alice".into(),
            })
            .await
            .expect("set user");

        let mut recorder: TerminalRecorder = services
            .recordings
            .lock()
            .await
            .start(&id, Some("shell".to_owned()), ())
            .await
            .expect("start recording");
        recorder
            .write(TerminalRecordingStreamId::Output, b"hello")
            .await
            .expect("write recording");
        let path = services.recordings.lock().await.path_for(&id, "shell");

        // The session ends once it has been asked to close.
        tokio::spawn({
            let closed = closed.clone();
            async move {
                while !closed.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                drop(recorder);
                drop(handle);
            }
        });

        services.shutdown(Duration::from_secs(10)).await;

        assert!(closed.load(Ordering::SeqCst));
        assert!(services.state.read().await.sessions.is_empty());
        let content = tokio::fs::read(&path).await.expect("read recording");
        assert!(!content.is_empty());
        let db = services.db_required().await.expect("db");
        let recording = Recording::Entity::find()
            .one(&db)
            .await
            .expect("query recording")
            .expect("recording row");
        assert!(recording.ended.is_some());
    }

    #[tokio::test]
    async fn unauthenticated_session_leaves_no_row() {
        let services = services_with_recordings().await;
        let (handle, _closed) = register_session(&services).await;
        let id = handle.lock().await.id();
        services.state.write().await.remove_session(id).await;

        let db = services.db_required().await.expect("db");
        let row = Session::Entity::find_by_id(id)
            .one(&db)
            .await
            .expect("query");
        assert!(row.is_none());
    }

    #[tokio::test]
    async fn authenticated_session_is_recorded_from_its_start() {
        let services = services_with_recordings().await;
        let before = chrono::Utc::now();
        let (handle, _closed) = register_session(&services).await;
        let id = handle.lock().await.id();
        let user = AuthStateUserInfo {
            id: Uuid::new_v4(),
            username: "alice".into(),
        };
        handle
            .lock()
            .await
            .set_user_info(user.clone())
            .await
            .expect("set user");
        // Repeated authentication (HTTP sets it per request) keeps one row.
        handle
            .lock()
            .await
            .set_user_info(user)
            .await
            .expect("set user again");

        let db = services.db_required().await.expect("db");
        let row = Session::Entity::find_by_id(id)
            .one(&db)
            .await
            .expect("query")
            .expect("session row");
        assert_eq!(row.username.as_deref(), Some("alice"));
        assert_eq!(row.protocol, "SSH");
        assert!(row.started >= before);
        assert!(row.ended.is_none());

        services.state.write().await.remove_session(id).await;
        let row = Session::Entity::find_by_id(id)
            .one(&db)
            .await
            .expect("query")
            .expect("session row");
        assert!(row.ended.is_some());
    }

    #[tokio::test]
    async fn shutdown_gives_up_after_timeout() {
        let services = services_with_recordings().await;
        let (_handle, closed) = register_session(&services).await;

        services.shutdown(Duration::from_millis(50)).await;

        assert!(closed.load(Ordering::SeqCst));
        assert_eq!(services.state.read().await.sessions.len(), 1);
    }
}
