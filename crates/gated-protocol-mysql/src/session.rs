use std::net::SocketAddr;
use std::ops::Deref;
use std::sync::Arc;
use std::time::Instant;

use bytes::{Buf, Bytes, BytesMut};
use gated_common::auth::{
    AuthCredential, AuthResult, AuthSelector, AuthStateUserInfo, CredentialKind,
};
use gated_common::helpers::rng::get_crypto_rng;
use gated_common::{Secret, TargetMySqlOptions, TargetOptions};
use gated_core::command_acl::AclAction;
use gated_core::command_acl_loader::DbCommandAclEnforcer;
use gated_core::recordings::{SqlAuditRecordingItem, SqlAuditSessionMetadata, StructuredRecorder};
use gated_core::{authorize_ticket, consume_ticket, ConfigProvider, GatedServerHandle, Services};
use gated_database_protocols::io::{BufExt, Decode};
use gated_database_protocols::mysql::protocol::auth::AuthPlugin;
use gated_database_protocols::mysql::protocol::connect::{
    AuthSwitchRequest, Handshake, HandshakeResponse,
};
use gated_database_protocols::mysql::protocol::response::{ErrPacket, OkPacket, Status};
use gated_database_protocols::mysql::protocol::text::Query;
use gated_database_protocols::mysql::protocol::Capabilities;
use rand::Rng;
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;

use crate::client::{ConnectionOptions, MySqlClient};
use crate::error::MySqlError;
use crate::stream::MySqlStream;

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

pub struct MySqlSession<S: AsyncRead + AsyncWrite + Send + Unpin> {
    stream: MySqlStream<S, tokio_rustls::server::TlsStream<S>>,
    capabilities: Capabilities,
    challenge: [u8; 20],
    username: Option<String>,
    database: Option<String>,
    tls_config: Arc<ServerConfig>,
    server_handle: Arc<Mutex<GatedServerHandle>>,
    id: Uuid,
    services: Services,
    remote_address: SocketAddr,
}

impl<S: AsyncRead + AsyncWrite + Send + Unpin> MySqlSession<S> {
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
            stream: MySqlStream::new(stream),
            capabilities: Capabilities::PROTOCOL_41
                | Capabilities::PLUGIN_AUTH
                | Capabilities::FOUND_ROWS
                | Capabilities::LONG_FLAG
                | Capabilities::NO_SCHEMA
                | Capabilities::PLUGIN_AUTH_LENENC_DATA
                | Capabilities::CONNECT_WITH_DB
                | Capabilities::SESSION_TRACK
                | Capabilities::IGNORE_SPACE
                | Capabilities::INTERACTIVE
                | Capabilities::TRANSACTIONS
                | Capabilities::DEPRECATE_EOF
                | Capabilities::SECURE_CONNECTION
                | Capabilities::SSL,
            challenge: get_crypto_rng().gen(),
            tls_config: Arc::new(tls_config),
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
                info_span!("MySQL", session=%self.id, session_username=%username, %client_ip)
            }
            None => info_span!("MySQL", session=%self.id, %client_ip),
        }
    }

    pub async fn run(mut self) -> Result<(), MySqlError> {
        let mut challenge_1 = BytesMut::from(&self.challenge[..]);
        let challenge_2 = challenge_1.split_off(8);
        let challenge_chain = challenge_1.freeze().chain(challenge_2.freeze());

        let handshake = Handshake {
            protocol_version: 10,
            server_version: "8.0.0-Gated".to_owned(),
            connection_id: 1,
            auth_plugin_data: challenge_chain,
            server_capabilities: self.capabilities,
            server_default_collation: 45,
            status: Status::empty(),
            auth_plugin: Some(AuthPlugin::MySqlNativePassword),
        };
        self.stream.push(&handshake, ())?;
        self.stream.flush().await?;

        let resp = loop {
            let Some(payload) = self.stream.recv().await? else {
                return Err(MySqlError::Eof);
            };
            let resp = HandshakeResponse::decode_with(payload, &mut self.capabilities)
                .map_err(MySqlError::decode)?;

            trace!(?resp, "Handshake response");
            info!(capabilities=?self.capabilities, username=%resp.username, "User handshake");

            if self.capabilities.contains(Capabilities::SSL) {
                if self.stream.is_tls() {
                    break resp;
                }
                self.stream = self.stream.upgrade(self.tls_config.clone()).await?;
                continue;
            } else {
                self.send_error(1002, "Gated requires TLS - please enable it in your client: add `--ssl` on the CLI or add `?sslMode=PREFERRED` to your database URI").await?;
                return Err(MySqlError::TlsNotSupportedByClient);
            }
        };

        if resp.auth_plugin == Some(AuthPlugin::MySqlClearPassword) {
            if let Some(mut response) = resp.auth_response.clone() {
                let password = Secret::new(response.get_str_nul()?);
                return self.run_authorization(resp, password).await;
            }
        }

        let req = AuthSwitchRequest {
            plugin: AuthPlugin::MySqlClearPassword,
            data: Bytes::new(),
        };
        self.stream.push(&req, ())?;

        self.stream.flush().await?;

        let Some(response) = &self.stream.recv().await? else {
            return Err(MySqlError::Eof);
        };
        let password = Secret::new(response.clone().get_str_nul()?);
        self.run_authorization(resp, password).await
    }

    async fn send_error(&mut self, code: u16, message: &str) -> Result<(), MySqlError> {
        self.stream.push(
            &ErrPacket {
                error_code: code,
                error_message: message.to_owned(),
                sql_state: None,
            },
            (),
        )?;
        self.stream.flush().await?;
        Ok(())
    }

    /// Append a single SQL audit item to this session's `sql-proxy` recording.
    /// Best-effort: recording unavailability is logged, not surfaced to the
    /// client. Mirrors the inline audit write in the COM_QUERY relay loop.
    async fn record_sql_audit(
        &mut self,
        item: SqlAuditRecordingItem,
        metadata: SqlAuditSessionMetadata,
    ) {
        let mut recordings = self.services.recordings.lock().await;
        match recordings
            .start::<StructuredRecorder, _>(&self.id, Some("sql-proxy".to_string()), metadata)
            .await
        {
            Ok(mut recorder) => {
                if let Err(err) = recorder.write_item(&item).await {
                    debug!(%err, session=%self.id, "Failed to append MySQL query audit item");
                }
            }
            Err(err) => {
                debug!(%err, session=%self.id, "MySQL query recording not available");
            }
        }
    }

    pub async fn run_authorization(
        mut self,
        handshake: HandshakeResponse,
        password: Secret<String>,
    ) -> Result<(), MySqlError> {
        let selector: AuthSelector = handshake.username.deref().into();

        async fn fail<S: AsyncRead + AsyncWrite + Send + Unpin>(
            this: &mut MySqlSession<S>,
        ) -> Result<(), MySqlError> {
            this.stream.push(
                &ErrPacket {
                    error_code: 1,
                    error_message: "Gated access denied".to_owned(),
                    sql_state: None,
                },
                (),
            )?;
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
                let mut state = state_arc.lock().await;

                let user_auth_result = {
                    let credential = AuthCredential::Password(password);

                    let mut cp = self.services.config_provider.lock().await;
                    if cp.validate_credential(&username, &credential).await? {
                        state.add_valid_credential(credential);
                    }

                    state.verify()
                };

                match user_auth_result {
                    AuthResult::Accepted { user_info } => {
                        self.services
                            .auth_state_store
                            .lock()
                            .await
                            .complete(state.id())
                            .await;
                        let target_auth_result = {
                            self.services
                                .config_provider
                                .lock()
                                .await
                                .authorize_target(&user_info.username, &target_name)
                                .await
                                .map_err(MySqlError::other)?
                        };
                        if !target_auth_result {
                            warn!(target: "audit",
                                "Target {} not authorized for user {}",
                                target_name, user_info.username
                            );
                            return fail(&mut self).await;
                        }
                        self.run_authorized(handshake, user_info, target_name).await
                    }
                    AuthResult::Rejected | AuthResult::Need(_) => fail(&mut self).await,
                }
            }
            AuthSelector::Ticket { secret } => {
                match authorize_ticket(&self.services.db, &secret)
                    .await
                    .map_err(MySqlError::other)?
                {
                    Some((ticket, user_info)) => {
                        info!("Authorized for {} with a ticket", ticket.target);
                        consume_ticket(&self.services.db, &ticket.id)
                            .await
                            .map_err(MySqlError::other)?;

                        self.run_authorized(handshake, user_info, ticket.target)
                            .await
                    }
                    _ => fail(&mut self).await,
                }
            }
        }
    }

    async fn run_authorized(
        mut self,
        handshake: HandshakeResponse,
        user_info: AuthStateUserInfo,
        target_name: String,
    ) -> Result<(), MySqlError> {
        self.stream.push(
            &OkPacket {
                affected_rows: 0,
                last_insert_id: 0,
                status: Status::empty(),
                warnings: 0,
            },
            (),
        )?;
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
                    TargetOptions::MySql(ref options) => Some((t, options)),
                    _ => None,
                })
                .find(|(t, _)| t.name == target_name)
                .map(|(t, opt)| (t.clone(), opt.clone()))
        };

        let Some((target, mysql_options)) = target else {
            warn!("Selected target not found");
            self.stream.push(
                &ErrPacket {
                    error_code: 1,
                    error_message: "Gated access denied".to_owned(),
                    sql_state: None,
                },
                (),
            )?;
            self.stream.flush().await?;
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
        // them before the upstream connect.  Mirror of the SSH session's
        // gated_core::account_credentials::ssh_options_with_account.
        let mysql_options = {
            let db = gated_core::db_required(&self.services.db)
                .await
                .map_err(MySqlError::other)?;
            match gated_core::account_credentials::resolve_db_account(&db, &target).await {
                Ok(Some((_, creds))) => {
                    let mut o = mysql_options;
                    o.username = creds.username;
                    o.password = Some(creds.password);
                    o
                }
                Ok(None) => mysql_options,
                Err(error) => {
                    error!(%error, "Account resolution failed");
                    self.send_error(1045, "Access denied").await?;
                    return Ok(());
                }
            }
        };

        // Build the per-session command-ACL enforcer (resolves the user's
        // roles up front). With no enabled rules this is inert (default OFF).
        let acl = {
            let db = gated_core::db_required(&self.services.db)
                .await
                .map_err(MySqlError::other)?;
            DbCommandAclEnforcer::new(db, acl_target_id, acl_user_id)
                .await
                .map_err(MySqlError::other)?
        };

        self.run_authorized_inner(handshake, target_name, mysql_options, acl)
            .await
    }

    async fn run_authorized_inner(
        mut self,
        handshake: HandshakeResponse,
        target_name: String,
        options: TargetMySqlOptions,
        acl: DbCommandAclEnforcer,
    ) -> Result<(), MySqlError> {
        self.database = handshake.database.clone();
        self.username = Some(handshake.username);
        if let Some(ref database) = handshake.database {
            info!("Selected database: {database}");
        }

        let mut client = match MySqlClient::connect(
            &options,
            ConnectionOptions {
                collation: handshake.collation,
                database: handshake.database,
                max_packet_size: handshake.max_packet_size,
                capabilities: self.capabilities,
            },
        )
        .await
        {
            Err(error) => {
                error!(%error, "Target connection failed");
                self.send_error(1045, "Access denied").await?;
                Err(error)
            }
            x => x,
        }?;

        self.server_handle
            .lock()
            .await
            .audit_target_connected()
            .await;

        loop {
            self.stream.reset_sequence_id();
            client.stream.reset_sequence_id();
            let Some(payload) = self.stream.recv().await? else {
                break;
            };
            trace!(?payload, "server got packet");

            let com = payload.first();

            // COM_QUERY
            if com == Some(&0x03) {
                let query = Query::decode(payload)?;
                info!(query=%query.0, "SQL");
                let started = Instant::now();
                let statement_kind = classify_sql(&query.0);
                let mut success = true;
                let mut error_message = None;

                // Command-ACL enforcement. An empty ruleset (or no match) yields
                // Allow. Deny and Review both block: DB proxies have no interactive
                // approval path. A rule-load failure fails open (forwards) so a
                // policy-DB outage does not lock users out; it is logged at WARN
                // and audited. Evaluated verdicts always fail safe.
                let decision = match acl.evaluate("mysql", &query.0).await {
                    Ok(decision) => Some(decision),
                    Err(err) => {
                        warn!(%err, session=%self.id, "Command-ACL rule load failed; forwarding query (fail-open, command control degraded)");
                        let metadata = SqlAuditSessionMetadata::MySqlProxySession {
                            target: target_name.clone(),
                            database: self.database.clone(),
                        };
                        let item = SqlAuditRecordingItem::Query {
                            timestamp: chrono::Utc::now(),
                            target_kind: "mysql".to_string(),
                            target: target_name.clone(),
                            database: self.database.clone(),
                            sql: query.0.clone(),
                            statement_kind: statement_kind.clone(),
                            readonly: None,
                            elapsed_ms: started.elapsed().as_millis() as u64,
                            success: true,
                            error: Some(
                                "acl-load-error: command control degraded (fail-open)".to_string(),
                            ),
                        };
                        self.record_sql_audit(item, metadata).await;
                        None
                    }
                };
                // Fail-OPEN on load error: `None` (no decision) forwards. Only an
                // evaluated Deny/Review blocks.
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
                    let metadata = SqlAuditSessionMetadata::MySqlProxySession {
                        target: target_name.clone(),
                        database: self.database.clone(),
                    };
                    let item = SqlAuditRecordingItem::Query {
                        timestamp: chrono::Utc::now(),
                        target_kind: "mysql".to_string(),
                        target: target_name.clone(),
                        database: self.database.clone(),
                        sql: query.0.clone(),
                        statement_kind,
                        readonly: None,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        success: false,
                        error: Some(audit_error),
                    };
                    self.record_sql_audit(item, metadata).await;
                    self.send_error(1045, "command blocked by policy").await?;
                    continue;
                }

                client.stream.push(&query, ())?;
                client.stream.flush().await?;

                let mut eof_ctr = 0;
                let mut first_response = true;
                loop {
                    let Some(response) = client.stream.recv().await? else {
                        return Err(MySqlError::Eof);
                    };
                    trace!(?response, "client got packet");
                    // A malicious upstream may answer COM_QUERY with a
                    // LOCAL INFILE request (first byte 0xfb) even though we never
                    // advertise CLIENT_LOCAL_FILES. Forwarding it desyncs the relay
                    // (the client never negotiated the capability and would not reply
                    // with file contents), so reject it as a protocol violation. 0xfb
                    // is only ambiguous inside row data (NULL marker); here it can only
                    // appear as the first packet of the query response.
                    if first_response && response.first() == Some(&0xfb) {
                        return Err(MySqlError::ProtocolError(
                            "upstream requested LOCAL INFILE (0xfb) but LOCAL_FILES is disabled"
                                .to_string(),
                        ));
                    }
                    first_response = false;
                    self.stream.push(&&response[..], ())?;
                    self.stream.flush().await?;
                    if let Some(com) = response.first() {
                        if com == &0xff {
                            success = false;
                            if let Ok(err) =
                                ErrPacket::decode_with(response.clone(), self.capabilities)
                            {
                                error_message = Some(err.error_message);
                            }
                        }
                        if com == &0xfe {
                            if self.capabilities.contains(Capabilities::DEPRECATE_EOF) {
                                break;
                            }
                            eof_ctr += 1;
                            if eof_ctr == 2 {
                                // todo check multiple results
                                break;
                            }
                        }
                        if com == &0 || com == &0xff {
                            break;
                        }
                    }
                }
                let metadata = SqlAuditSessionMetadata::MySqlProxySession {
                    target: target_name.clone(),
                    database: self.database.clone(),
                };
                let item = SqlAuditRecordingItem::Query {
                    timestamp: chrono::Utc::now(),
                    target_kind: "mysql".to_string(),
                    target: target_name.clone(),
                    database: self.database.clone(),
                    sql: query.0,
                    statement_kind,
                    readonly: None,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    success,
                    error: error_message,
                };
                let mut recordings = self.services.recordings.lock().await;
                match recordings
                    .start::<StructuredRecorder, _>(
                        &self.id,
                        Some("sql-proxy".to_string()),
                        metadata,
                    )
                    .await
                {
                    Ok(mut recorder) => {
                        if let Err(err) = recorder.write_item(&item).await {
                            debug!(%err, session=%self.id, "Failed to append MySQL query audit item");
                        }
                    }
                    Err(err) => {
                        debug!(%err, session=%self.id, "MySQL query recording not available");
                    }
                }
            // COM_QUIT
            } else if com == Some(&0x01) {
                break;
            // COM_INIT_DB
            } else if com == Some(&0x02) {
                let mut buf = payload.clone();
                buf.advance(1);
                let db = buf.get_str(buf.len())?;
                self.database = Some(db.clone());
                info!("Selected database: {db}");
                client.stream.push(&&payload[..], ())?;
                client.stream.flush().await?;
                self.passthrough_until_result(&mut client).await?;
            // COM_FIELD_LIST, COM_PING, COM_RESET_CONNECTION
            } else if com == Some(&0x04) || com == Some(&0x0e) || com == Some(&0x1f) {
                client.stream.push(&&payload[..], ())?;
                client.stream.flush().await?;
                self.passthrough_until_result(&mut client).await?;
            } else if let Some(com) = com {
                warn!("Unknown packet type {com}");
                self.send_error(1047, "Not implemented").await?;
            } else {
                break;
            }
        }

        Ok(())
    }

    async fn passthrough_until_result(
        &mut self,
        client: &mut MySqlClient,
    ) -> Result<(), MySqlError> {
        loop {
            let Some(response) = client.stream.recv().await? else {
                return Err(MySqlError::Eof);
            };
            trace!(?response, "client got packet");
            self.stream.push(&&response[..], ())?;
            self.stream.flush().await?;
            if let Some(com) = response.first() {
                if com == &0 || com == &0xff || com == &0xfe {
                    break;
                }
            }
        }
        Ok(())
    }
}
