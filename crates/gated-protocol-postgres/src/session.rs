use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use gated_common::auth::{
    AuthCredential, AuthResult, AuthSelector, AuthStateUserInfo, CredentialKind,
};
use gated_common::{Secret, TargetOptions, TargetPostgresOptions};
use gated_core::command_acl::AclAction;
use gated_core::command_acl_loader::DbCommandAclEnforcer;
use gated_core::recordings::{SqlAuditRecordingItem, SqlAuditSessionMetadata, StructuredRecorder};
use gated_core::{ConfigProvider, GatedServerHandle, Services, authorize_ticket, consume_ticket};
use pgwire::error::ErrorInfo;
use pgwire::messages::response::{ReadyForQuery, TransactionStatus};
use pgwire::messages::{PgWireBackendMessage, PgWireFrontendMessage};
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;
use tokio::time;
use tokio_rustls::server::TlsStream;
use tracing::*;
use uuid::Uuid;

use crate::client::{ConnectionOptions, PostgresClient};
use crate::error::PostgresError;
use crate::stream::{PgWireGenericFrontendMessage, PgWireStartupOrSslRequest, PostgresStream};

struct PendingSqlAudit {
    sql: String,
    statement_kind: String,
    started_at: Instant,
}

fn classify_sql(sql: &str) -> String {
    let trimmed = sql.trim_start();
    let first: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    match first.as_str() {
        "SELECT" | "WITH" => "SELECT".to_string(),
        "SHOW" => "SHOW".to_string(),
        "EXPLAIN" => "EXPLAIN".to_string(),
        "DESC" | "DESCRIBE" => "DESCRIBE".to_string(),
        "INSERT" => "INSERT".to_string(),
        "UPDATE" => "UPDATE".to_string(),
        "DELETE" => "DELETE".to_string(),
        "CREATE" => "CREATE".to_string(),
        "DROP" => "DROP".to_string(),
        "ALTER" => "ALTER".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "UNKNOWN".to_string(),
    }
}

/// Enforce that the connection is encrypted before any gated password is
/// solicited. When the client negotiated TLS via `SslRequest`,
/// `tls_negotiated` is true and this is a no-op. Otherwise — a plain `Startup`
/// from `sslmode=disable`, or a MITM that stripped the `SslRequest` — a FATAL
/// `ErrorResponse` is emitted and `TlsNotSupported` returned so the caller
/// aborts the connection before issuing a `CleartextPassword` challenge. This
/// mirrors the MySQL proxy's reject-non-TLS behavior.
async fn enforce_tls<S: AsyncRead + AsyncWrite + Send + Unpin>(
    stream: &mut PostgresStream<S, TlsStream<S>>,
    tls_negotiated: bool,
) -> Result<(), PostgresError> {
    if tls_negotiated {
        return Ok(());
    }

    let error_info = ErrorInfo::new(
        "FATAL".to_owned(),
        "28000".to_owned(),
        "Gated requires TLS - please enable it in your client: use `sslmode=require` (or stronger) in your connection string".to_owned(),
    );
    stream.push(pgwire::messages::response::ErrorResponse::from(error_info))?;
    stream.flush().await?;
    Err(PostgresError::TlsNotSupported)
}

pub struct PostgresSession<S: AsyncRead + AsyncWrite + Send + Unpin> {
    stream: PostgresStream<S, TlsStream<S>>,
    tls_config: Arc<ServerConfig>,
    username: Option<String>,
    database: Option<String>,
    server_handle: Arc<Mutex<GatedServerHandle>>,
    id: Uuid,
    services: Services,
    remote_address: SocketAddr,
}

impl<S: AsyncRead + AsyncWrite + Send + Unpin> PostgresSession<S> {
    pub async fn new(
        server_handle: Arc<Mutex<GatedServerHandle>>,
        services: Services,
        stream: S,
        tls_config: ServerConfig,
        remote_address: SocketAddr,
    ) -> Self {
        let id = server_handle.lock().await.id();

        Self {
            services,
            tls_config: Arc::new(tls_config),
            stream: PostgresStream::new(stream),
            username: None,
            database: None,
            server_handle,
            id,
            remote_address,
        }
    }

    pub fn make_logging_span(&self) -> tracing::Span {
        let client_ip = self.remote_address.ip().to_string();
        match self.username {
            Some(ref username) => {
                info_span!("PostgreSQL", session=%self.id, session_username=%username, %client_ip)
            }
            None => info_span!("PostgreSQL", session=%self.id, %client_ip),
        }
    }

    pub async fn run(mut self) -> Result<(), PostgresError> {
        let Some(mut initial_message) = self.stream.recv::<PgWireStartupOrSslRequest>().await?
        else {
            return Err(PostgresError::Eof);
        };

        let mut tls_negotiated = false;

        if let PgWireStartupOrSslRequest::SslRequest(_) = &initial_message {
            debug!("Received SslRequest");
            self.stream
                .push(pgwire::messages::response::SslResponse::Accept)?;
            self.stream.flush().await?;
            self.stream = self.stream.upgrade(self.tls_config.clone()).await?;
            tls_negotiated = true;
            debug!("TLS setup complete");

            let Some(next_message) = self.stream.recv::<PgWireStartupOrSslRequest>().await? else {
                return Err(PostgresError::Eof);
            };

            initial_message = next_message;
        }

        let PgWireStartupOrSslRequest::Startup(startup) = initial_message else {
            return Err(PostgresError::ProtocolError("expected Startup".into()));
        };

        // Refuse to solicit a password over a plaintext socket. A client that did
        // not negotiate TLS via SslRequest (e.g. `sslmode=disable`, or a MITM that
        // stripped the SslRequest) reaches this point on a raw stream; emit a FATAL
        // ErrorResponse and abort before any CleartextPassword challenge.
        enforce_tls(&mut self.stream, tls_negotiated).await?;

        let username = startup.parameters.get("user").cloned();
        self.username = username.clone();
        self.database = startup.parameters.get("database").cloned();

        self.run_authorization(startup, &username.unwrap_or("".into()))
            .await
    }

    pub async fn run_authorization(
        mut self,
        startup: pgwire::messages::startup::Startup,
        username: &String,
    ) -> Result<(), PostgresError> {
        let selector: AuthSelector = username.into();

        async fn fail<S: AsyncRead + AsyncWrite + Send + Unpin>(
            this: &mut PostgresSession<S>,
        ) -> Result<(), PostgresError> {
            let error_info = ErrorInfo::new(
                "FATAL".to_owned(),
                "28P01".to_owned(),
                "Authentication failed".to_owned(),
            );

            this.stream
                .push(pgwire::messages::response::ErrorResponse::from(error_info))?;
            this.stream.flush().await?;
            Ok(())
        }

        match selector {
            AuthSelector::User {
                username,
                target_name,
            } => {
                let state_arc = self
                    .services
                    .auth_state_store
                    .lock()
                    .await
                    .create(
                        Some(&self.server_handle.lock().await.id()),
                        &username,
                        crate::common::PROTOCOL_NAME,
                        &[CredentialKind::Password],
                    )
                    .await?
                    .1;

                let mut auth_ok_sent = false;

                loop {
                    let user_auth_result = state_arc.lock().await.verify();

                    match user_auth_result {
                        AuthResult::Accepted { user_info } => {
                            self.services
                                .auth_state_store
                                .lock()
                                .await
                                .complete(state_arc.lock().await.id())
                                .await;
                            let target_auth_result = {
                                self.services
                                    .config_provider
                                    .lock()
                                    .await
                                    .authorize_target(&user_info.username, &target_name)
                                    .await
                                    .map_err(PostgresError::other)?
                            };
                            if !target_auth_result {
                                warn!(target: "audit","Target {target_name} not authorized for user {username}",);
                                return fail(&mut self).await;
                            }

                            if !auth_ok_sent {
                                self.stream
                                    .push(pgwire::messages::startup::Authentication::Ok)?;
                            }
                            return self.run_authorized(startup, user_info, target_name).await;
                        }
                        AuthResult::Need(kinds) => {
                            if kinds.contains(&CredentialKind::Password) {
                                self.stream.push(
                                    pgwire::messages::startup::Authentication::CleartextPassword,
                                )?;
                                self.stream.flush().await?;

                                let Some(PgWireGenericFrontendMessage(
                                    PgWireFrontendMessage::PasswordMessageFamily(message),
                                )) = self.stream.recv::<PgWireGenericFrontendMessage>().await?
                                else {
                                    return Err(PostgresError::Eof);
                                };

                                let password = Secret::from(
                                    message
                                        .into_password()
                                        .map_err(PostgresError::from)?
                                        .password,
                                );

                                let mut state = state_arc.lock().await;

                                let credential = AuthCredential::Password(password);

                                if self
                                    .services
                                    .config_provider
                                    .lock()
                                    .await
                                    .validate_credential(&username, &credential)
                                    .await?
                                {
                                    state.add_valid_credential(credential);
                                } else {
                                    // Postgres CLI will just send the same password in a loop without prompting the user again
                                    return fail(&mut self).await;
                                }
                            } else if kinds.contains(&CredentialKind::WebUserApproval) {
                                // Only WebUserApproval is needed, i.e. the password was either correct or not required, otherwise just fail early

                                let identification_string =
                                    state_arc.lock().await.identification_string().to_owned();
                                let auth_state_id = *state_arc.lock().await.id();
                                let mut event = self
                                    .services
                                    .auth_state_store
                                    .lock()
                                    .await
                                    .subscribe(auth_state_id);

                                let login_url_result =
                                    state_arc.lock().await.construct_web_approval_url(
                                        &*self.services.config.read().await,
                                    );
                                let login_url = match login_url_result {
                                    Ok(login_url) => login_url,
                                    Err(error) => {
                                        error!(?error, "Failed to construct external URL");
                                        return fail(&mut self).await;
                                    }
                                };

                                if !auth_ok_sent {
                                    self.stream
                                        .push(pgwire::messages::startup::Authentication::Ok)?;
                                    auth_ok_sent = true;
                                }

                                self.stream
                                    .push(pgwire::messages::response::NoticeResponse::new(vec![
                                        (b'S', "WARNING".into()),
                                        (b'V', "WARNING".into()),
                                        (b'C', "WG001".into()),
                                        (b'M', "Gated authentication: please open the following URL in your browser:".into()),
                                        (b'D', login_url.into()),
                                        (b'H', format!(
                                            "Make sure you're seeing this security key: {}\n",
                                            identification_string
                                                .chars()
                                                .map(|x| x.to_string())
                                                .collect::<Vec<_>>()
                                                .join(" ")
                                        )),
                                    ]))?;
                                self.stream.flush().await?;

                                if !matches!(event.recv().await, Ok(AuthResult::Accepted { .. })) {
                                    warn!(target: "audit","Web user approval failed");
                                    return fail(&mut self).await;
                                }
                            } else {
                                return fail(&mut self).await;
                            }
                        }
                        AuthResult::Rejected => return fail(&mut self).await,
                    }
                }
            }
            AuthSelector::Ticket { secret } => {
                match authorize_ticket(&self.services.db, &secret)
                    .await
                    .map_err(PostgresError::other)?
                {
                    Some((ticket, user_info)) => {
                        info!("Authorized for {} with a ticket", ticket.target);
                        consume_ticket(&self.services.db, &ticket.id)
                            .await
                            .map_err(PostgresError::other)?;

                        self.stream
                            .push(pgwire::messages::startup::Authentication::Ok)?;
                        self.run_authorized(startup, user_info, ticket.target).await
                    }
                    _ => fail(&mut self).await,
                }
            }
        }
    }

    async fn run_authorized(
        mut self,
        startup: pgwire::messages::startup::Startup,
        user_info: AuthStateUserInfo,
        target_name: String,
    ) -> Result<(), PostgresError> {
        self.stream.flush().await?;

        let target = {
            self.services
                .config_provider
                .lock()
                .await
                .list_targets()
                .await?
                .iter()
                .filter_map(|t| match t.options {
                    TargetOptions::Postgres(ref options) => Some((t, options)),
                    _ => None,
                })
                .find(|(t, _)| t.name == target_name)
                .map(|(t, opt)| (t.clone(), opt.clone()))
        };

        let Some((target, postgres_options)) = target else {
            warn!("Selected target not found");
            self.send_error_response(
                "0W001".into(),
                format!("Gated target {target_name} not found"),
            )
            .await?;
            return Ok(());
        };

        // Capture the ACL scope (target + acting user) before `user_info` is
        // moved into the server handle below.
        let acl_target_id = target.id;
        let acl_user_id = user_info.id;

        {
            let handle = self.server_handle.lock().await;
            handle.set_user_info(user_info).await?;
            handle.set_target(&target).await?;
        }

        // Resolve bound primary account: if the target has an `accounts[]`
        // binding, the inline username/password were cleared at create-time
        // (see admin::api::targets::clear_inline_credentials). Pull the
        // real credentials from the bound db-password account and inject
        // them before the upstream connect. Mirror of the MySQL session
        // patch and SSH's ssh_options_with_account.
        let postgres_options = {
            let db = gated_core::db_required(&self.services.db)
                .await
                .map_err(PostgresError::other)?;
            match gated_core::account_credentials::resolve_db_account(&db, &target).await {
                Ok(Some((_, creds))) => {
                    let mut o = postgres_options;
                    o.username = creds.username;
                    o.password = Some(creds.password);
                    o
                }
                Ok(None) => postgres_options,
                Err(error) => {
                    error!(%error, "Account resolution failed");
                    self.send_error_response(
                        "0W001".into(),
                        format!("Account resolution failed: {error}"),
                    )
                    .await?;
                    return Ok(());
                }
            }
        };

        // Build the per-session command-ACL enforcer (resolves the user's
        // roles up front). With no enabled rules this is inert (default OFF).
        let acl = {
            let db = gated_core::db_required(&self.services.db)
                .await
                .map_err(PostgresError::other)?;
            DbCommandAclEnforcer::new(db, acl_target_id, acl_user_id)
                .await
                .map_err(PostgresError::other)?
        };

        self.run_authorized_inner(startup, target_name, postgres_options, acl)
            .await
    }

    async fn send_error_response(
        &mut self,
        code: String,
        message: String,
    ) -> Result<(), PostgresError> {
        let error_info = ErrorInfo::new("FATAL".to_owned(), code, message);
        self.stream
            .push(pgwire::messages::response::ErrorResponse::from(error_info))?;
        self.stream.flush().await?;
        Ok(())
    }

    /// Append a single "blocked by ACL policy" audit item to this session's
    /// `sql-proxy` recording. Best-effort: recording unavailability is logged,
    /// not surfaced to the client. Used when a command is rejected before it
    /// reaches the upstream (so the response-side audit never fires).
    async fn record_blocked_sql_audit(&mut self, target_name: &str, sql: &str, error: String) {
        let metadata = SqlAuditSessionMetadata::PostgresProxySession {
            target: target_name.to_string(),
            database: self.database.clone(),
        };
        let item = SqlAuditRecordingItem::Query {
            timestamp: chrono::Utc::now(),
            target_kind: "postgres".to_string(),
            target: target_name.to_string(),
            database: self.database.clone(),
            sql: sql.to_string(),
            statement_kind: classify_sql(sql),
            readonly: None,
            elapsed_ms: 0,
            success: false,
            error: Some(error),
        };
        let mut recordings = self.services.recordings.lock().await;
        match recordings
            .start::<StructuredRecorder, _>(&self.id, Some("sql-proxy".to_string()), metadata)
            .await
        {
            Ok(mut recorder) => {
                if let Err(err) = recorder.write_item(&item).await {
                    debug!(%err, session=%self.id, "Failed to append Postgres blocked-query audit item");
                }
            }
            Err(err) => {
                debug!(%err, session=%self.id, "Postgres query recording not available");
            }
        }
    }

    /// Append a single "command control degraded (fail-open)" audit item when the
    /// ACL ruleset could not be loaded. The command is still forwarded (fail-open),
    /// so this is recorded as `success=true` with a warning note, keeping the
    /// degraded state observable and mirroring the MySQL/SSH degraded audit event.
    async fn record_degraded_sql_audit(&mut self, target_name: &str, sql: &str) {
        let metadata = SqlAuditSessionMetadata::PostgresProxySession {
            target: target_name.to_string(),
            database: self.database.clone(),
        };
        let item = SqlAuditRecordingItem::Query {
            timestamp: chrono::Utc::now(),
            target_kind: "postgres".to_string(),
            target: target_name.to_string(),
            database: self.database.clone(),
            sql: sql.to_string(),
            statement_kind: classify_sql(sql),
            readonly: None,
            elapsed_ms: 0,
            success: true,
            error: Some("acl-load-error: command control degraded (fail-open)".to_string()),
        };
        let mut recordings = self.services.recordings.lock().await;
        match recordings
            .start::<StructuredRecorder, _>(&self.id, Some("sql-proxy".to_string()), metadata)
            .await
        {
            Ok(mut recorder) => {
                if let Err(err) = recorder.write_item(&item).await {
                    debug!(%err, session=%self.id, "Failed to append Postgres degraded-control audit item");
                }
            }
            Err(err) => {
                debug!(%err, session=%self.id, "Postgres query recording not available");
            }
        }
    }

    async fn run_authorized_inner(
        mut self,
        startup: pgwire::messages::startup::Startup,
        target_name: String,
        options: TargetPostgresOptions,
        acl: DbCommandAclEnforcer,
    ) -> Result<(), PostgresError> {
        let mut client = match PostgresClient::connect(
            &options,
            ConnectionOptions {
                protocol_number_major: startup.protocol_number_major,
                protocol_number_minor: startup.protocol_number_minor,
                parameters: startup.parameters,
            },
        )
        .await
        {
            Err(error) => {
                self.send_error_response("0W002".into(), "Gated target connection failed".into())
                    .await?;
                Err(error)
            }
            x => x,
        }?;

        self.server_handle
            .lock()
            .await
            .audit_target_connected()
            .await;

        // Parse idle timeout from config
        let idle_timeout = options
            .idle_timeout
            .as_ref()
            .and_then(|s| {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    humantime::parse_duration(trimmed)
                        .map_err(|e| {
                            warn!(
                                timeout_string = %trimmed,
                                error = %e,
                                "Invalid idle_timeout value, falling back to default"
                            );
                            e
                        })
                        .ok()
                }
            })
            .unwrap_or(Duration::from_secs(60 * 10)); // Default 10 minutes

        if idle_timeout.as_secs() > 0 {
            info!(
                idle_timeout_seconds = idle_timeout.as_secs(),
                "Using configured idle timeout for session"
            );
        }

        let mut last_activity = std::time::Instant::now();
        let check_interval = Duration::from_secs(5); // Check idle timeout every 5 seconds
        let mut prepared_sql = std::collections::HashMap::<Option<String>, String>::new();
        let mut portal_sql = std::collections::HashMap::<Option<String>, String>::new();
        let mut pending_audit: Option<PendingSqlAudit> = None;

        loop {
            let elapsed = last_activity.elapsed();
            if elapsed > idle_timeout {
                info!(
                    idle_seconds = elapsed.as_secs(),
                    timeout_seconds = idle_timeout.as_secs(),
                    "Session idle timeout exceeded, closing connection"
                );
                self.send_error_response(
                    "57P01".into(),
                    format!(
                        "Session idle for {} exceeded configured timeout of {}. Please reconnect.",
                        humantime::format_duration(elapsed),
                        humantime::format_duration(idle_timeout)
                    ),
                )
                .await?;
                break;
            }

            let remaining_timeout = idle_timeout - elapsed;
            let select_timeout = remaining_timeout.min(check_interval);

            tokio::select! {
                c_to_s = time::timeout(select_timeout, self.stream.recv::<PgWireGenericFrontendMessage>()) => {
                    match c_to_s {
                        Ok(Ok(Some(msg))) => {
                            last_activity = std::time::Instant::now(); // Update activity on client message
                            self.maybe_log_client_msg(&msg.0);
                            // Classify the message: Parse/Bind only populate the
                            // prepared/portal maps; a simple Query or an extended
                            // Execute carries the executable SQL that must be
                            // ACL-gated before it reaches the upstream.
                            let (acl_sql, is_simple): (Option<String>, bool) = match &msg.0 {
                                PgWireFrontendMessage::Parse(query) => {
                                    prepared_sql.insert(query.name.clone(), query.query.clone());
                                    (None, false)
                                }
                                PgWireFrontendMessage::Bind(bind) => {
                                    if let Some(sql) = prepared_sql.get(&bind.statement_name).cloned() {
                                        portal_sql.insert(bind.portal_name.clone(), sql);
                                    }
                                    (None, false)
                                }
                                PgWireFrontendMessage::Execute(execute) => {
                                    let sql = portal_sql
                                        .get(&execute.name)
                                        .cloned()
                                        .unwrap_or_else(|| "<unknown prepared statement>".to_string());
                                    (Some(sql), false)
                                }
                                PgWireFrontendMessage::Query(query) => {
                                    (Some(query.query.clone()), true)
                                }
                                _ => (None, false),
                            };

                            if let Some(sql) = acl_sql {
                                // Command-ACL enforcement. An empty ruleset (or no match) yields
                                // Allow. Deny and Review both block: DB proxies have no interactive
                                // approval path. A rule-load failure fails open (forwards) so a
                                // policy-DB outage does not lock users out; it is logged at WARN
                                // and audited. Evaluated verdicts always fail safe.
                                let decision = match acl.evaluate("postgres", &sql).await {
                                    Ok(decision) => Some(decision),
                                    Err(err) => {
                                        warn!(%err, session=%self.id, "Command-ACL rule load failed; forwarding query (fail-open, command control degraded)");
                                        self.record_degraded_sql_audit(&target_name, &sql).await;
                                        None
                                    }
                                };
                                // Fail-OPEN on load error: `None` (no decision)
                                // forwards. Only an evaluated Deny/Review blocks.
                                let blocked = decision
                                    .as_ref()
                                    .map(|d| matches!(d.action, AclAction::Deny | AclAction::Review))
                                    .unwrap_or(false);
                                if blocked {
                                    let rule_id = decision.as_ref().and_then(|d| d.rule_id);
                                    let rule_name = decision.as_ref().and_then(|d| d.rule_name.clone());
                                    let outcome = match decision.as_ref().map(|d| d.action) {
                                        Some(AclAction::Review) => "blocked-review-unsupported",
                                        _ => "blocked",
                                    };
                                    warn!(session=%self.id, outcome, ?rule_id, "SQL command blocked by ACL policy");
                                    let audit_error = match rule_name {
                                        Some(name) => format!(
                                            "{outcome}: command blocked by ACL rule {} ({name})",
                                            rule_id.map(|i| i.to_string()).unwrap_or_default()
                                        ),
                                        None => outcome.to_string(),
                                    };
                                    self.record_blocked_sql_audit(&target_name, &sql, audit_error)
                                        .await;
                                    // Emit an ERROR (not FATAL) ErrorResponse so
                                    // the session stays open for the next query.
                                    let error_info = ErrorInfo::new(
                                        "ERROR".to_owned(),
                                        "42501".to_owned(),
                                        "command blocked by policy".to_owned(),
                                    );
                                    self.stream.push(
                                        pgwire::messages::response::ErrorResponse::from(error_info),
                                    )?;
                                    // Simple-query protocol: the backend follows
                                    // an error with ReadyForQuery. Extended
                                    // protocol: ReadyForQuery instead arrives from
                                    // the upstream after the client's Sync (which
                                    // we still forward), so we must NOT synthesize
                                    // one here or the client desyncs.
                                    if is_simple {
                                        self.stream
                                            .push(ReadyForQuery::new(TransactionStatus::Idle))?;
                                    }
                                    self.stream.flush().await?;
                                    continue; // do NOT forward the blocked statement
                                }

                                // Allowed: record the pending audit consumed by
                                // the response side once the upstream replies.
                                pending_audit = Some(PendingSqlAudit {
                                    statement_kind: classify_sql(&sql),
                                    sql,
                                    started_at: Instant::now(),
                                });
                            }
                            client.send(msg).await?;
                        }
                        Ok(Ok(None)) => {
                            break
                        }
                        Ok(Err(err)) => {
                            error!(error=%err, "Error receiving message");
                            break
                        }
                        Err(_) => {
                            // Timeout - check if we've exceeded idle timeout
                            continue;
                        }
                    };
                },
                s_to_c = client.recv() => {
                    match s_to_c {
                        Ok(Some(msg)) => {
                            last_activity = std::time::Instant::now(); // Update activity on server message
                            self.maybe_log_server_msg(&msg.0);
                            match &msg.0 {
                                PgWireBackendMessage::ErrorResponse(error) => {
                                    if let Some(pending) = pending_audit.take() {
                                        let metadata = SqlAuditSessionMetadata::PostgresProxySession {
                                            target: target_name.clone(),
                                            database: self.database.clone(),
                                        };
                                        let item = SqlAuditRecordingItem::Query {
                                            timestamp: chrono::Utc::now(),
                                            target_kind: "postgres".to_string(),
                                            target: target_name.clone(),
                                            database: self.database.clone(),
                                            sql: pending.sql,
                                            statement_kind: pending.statement_kind,
                                            readonly: None,
                                            elapsed_ms: pending.started_at.elapsed().as_millis() as u64,
                                            success: false,
                                            error: Some(format!("{error:?}")),
                                        };
                                        let mut recordings = self.services.recordings.lock().await;
                                        match recordings
                                            .start::<StructuredRecorder, _>(&self.id, Some("sql-proxy".to_string()), metadata)
                                            .await
                                        {
                                            Ok(mut recorder) => {
                                                if let Err(err) = recorder.write_item(&item).await {
                                                    debug!(%err, session=%self.id, "Failed to append Postgres query audit item");
                                                }
                                            }
                                            Err(err) => {
                                                debug!(%err, session=%self.id, "Postgres query recording not available");
                                            }
                                        }
                                    }
                                }
                                PgWireBackendMessage::CommandComplete(_)
                                | PgWireBackendMessage::EmptyQueryResponse(_)
                                | PgWireBackendMessage::PortalSuspended(_) => {
                                    if let Some(pending) = pending_audit.take() {
                                        let metadata = SqlAuditSessionMetadata::PostgresProxySession {
                                            target: target_name.clone(),
                                            database: self.database.clone(),
                                        };
                                        let item = SqlAuditRecordingItem::Query {
                                            timestamp: chrono::Utc::now(),
                                            target_kind: "postgres".to_string(),
                                            target: target_name.clone(),
                                            database: self.database.clone(),
                                            sql: pending.sql,
                                            statement_kind: pending.statement_kind,
                                            readonly: None,
                                            elapsed_ms: pending.started_at.elapsed().as_millis() as u64,
                                            success: true,
                                            error: None,
                                        };
                                        let mut recordings = self.services.recordings.lock().await;
                                        match recordings
                                            .start::<StructuredRecorder, _>(&self.id, Some("sql-proxy".to_string()), metadata)
                                            .await
                                        {
                                            Ok(mut recorder) => {
                                                if let Err(err) = recorder.write_item(&item).await {
                                                    debug!(%err, session=%self.id, "Failed to append Postgres query audit item");
                                                }
                                            }
                                            Err(err) => {
                                                debug!(%err, session=%self.id, "Postgres query recording not available");
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }
                            self.stream.push(msg)?;
                            self.stream.flush().await?;
                        }
                        Ok(None) => {
                            break
                        }
                        Err(err) => {
                            error!(error=%err, "Error receiving message");
                            break
                        }
                    };
                }
            };
        }

        Ok(())
    }

    fn maybe_log_client_msg(&self, msg: &PgWireFrontendMessage) {
        debug!(?msg, "C->S message");
        match msg {
            PgWireFrontendMessage::Parse(query) => {
                info!(query_name=?query.name, query=query.query, "Preparing query");
            }
            PgWireFrontendMessage::Execute(query) => {
                info!(query_name=?query.name, "Executing prepared query");
            }
            PgWireFrontendMessage::Query(query) => {
                info!(query=%query.query, "Query");
            }
            _ => (),
        }
    }

    fn maybe_log_server_msg(&self, msg: &PgWireBackendMessage) {
        debug!(?msg, "S->C message");
        if let PgWireBackendMessage::ErrorResponse(error) = msg {
            info!(?error, "PostgreSQL error");
        }
    }
}

#[cfg(test)]
mod tests {
    use bytes::BytesMut;
    use pgwire::messages::Message;
    use pgwire::messages::response::ErrorResponse;
    use tokio::io::AsyncReadExt;
    use tokio_rustls::server::TlsStream;

    use super::enforce_tls;
    use crate::error::PostgresError;
    use crate::stream::PostgresStream;

    // A connection that did not negotiate TLS must be rejected with a
    // FATAL ErrorResponse, and no CleartextPassword challenge may be sent first.
    #[tokio::test]
    async fn rejects_plaintext_with_fatal_and_no_password_prompt() {
        let (mut client, server) = tokio::io::duplex(4096);
        let mut stream = PostgresStream::<_, TlsStream<_>>::new(server);

        let result = enforce_tls(&mut stream, false).await;
        assert!(
            matches!(result, Err(PostgresError::TlsNotSupported)),
            "non-TLS connection must be refused, got {result:?}"
        );

        // Close the server side so the client read terminates at EOF.
        drop(stream);

        let mut buf = Vec::new();
        client.read_to_end(&mut buf).await.unwrap();

        // The only backend message on the wire is a single ErrorResponse ('E').
        // An authentication request (CleartextPassword) would start with 'R'.
        assert_eq!(
            buf.first(),
            Some(&b'E'),
            "first (and only) message must be an ErrorResponse"
        );

        let mut bytes = BytesMut::from(&buf[..]);
        let err = ErrorResponse::decode(&mut bytes)
            .unwrap()
            .expect("an ErrorResponse must be present");
        assert!(
            bytes.is_empty(),
            "exactly one message expected; no password challenge should follow"
        );
        assert!(
            err.fields.iter().any(|(_, v)| v == "FATAL"),
            "rejection must carry FATAL severity: {:?}",
            err.fields
        );
    }

    // A TLS-negotiated connection passes the gate untouched (no bytes emitted).
    #[tokio::test]
    async fn allows_tls_negotiated_connection() {
        let (mut client, server) = tokio::io::duplex(4096);
        let mut stream = PostgresStream::<_, TlsStream<_>>::new(server);

        let result = enforce_tls(&mut stream, true).await;
        assert!(result.is_ok(), "TLS connection must proceed: {result:?}");

        drop(stream);

        let mut buf = Vec::new();
        client.read_to_end(&mut buf).await.unwrap();
        assert!(
            buf.is_empty(),
            "TLS gate must not write anything to the client"
        );
    }
}
