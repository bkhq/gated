use super::targets_list::LoginQuery;
use super::terminal_details::{ConnectedDetails, HostKeyDetails};
use crate::http_service::common::upgrade;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::response::{IntoResponse, Response};
use gated_common::web::Data;
use http::StatusCode;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use gated_common::auth::AuthStateUserInfo;
use gated_common::{SshHostKeyVerificationMode, Target, TargetOptions, TargetSSHOptions};
use gated_core::command_acl::AclAction;
use gated_core::command_acl_loader::DbCommandAclEnforcer;
use gated_core::recordings::{
    CommandAuditRecorder, ShellCommandRecordingItem, ShellCommandSessionMetadata, TerminalRecorder,
    TerminalRecordingStreamId,
};
use gated_core::{ConfigProvider, Services, SessionStateInit, State};
use gated_protocol_ssh::{
    ChannelOperation, ConnectionError, PtyRequest, RCCommand, RCEvent, RCState, RemoteClient,
    RemoteClientHandles, SshRecordingMetadata,
};
use russh::keys::{HashAlg, PublicKey, PublicKeyBase64};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;

use super::super::common::{RequestAuthorization, SessionAuthorization};
use super::common::{TERMINAL_CLOSED_MESSAGE, TerminalSessionHandle};

/// Maximum allowed length for target names
const MAX_TARGET_NAME_LEN: usize = 128;

/// Maximum concurrent web terminal sessions per user
const MAX_SESSIONS_PER_USER: usize = 10;

/// WebSocket ping interval for keepalive
const WS_PING_INTERVAL: Duration = Duration::from_secs(30);

/// Timeout for host key verification prompt
const HOST_KEY_VERIFY_TIMEOUT: Duration = Duration::from_secs(60);

/// Binary protocol message types:
/// 0x00 = terminal data
/// 0x01 = resize JSON
/// 0x02 = status JSON (server -> client)
/// 0x03 = host key verification (bidirectional)
const TICKET_RECHECK_INTERVAL: Duration = Duration::from_secs(10);

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

const MSG_TERMINAL_DATA: u8 = 0x00;
const MSG_RESIZE: u8 = 0x01;
const MSG_STATUS: u8 = 0x02;
const MSG_HOST_KEY_VERIFY: u8 = 0x03;

const UNKNOWN_HOST_KEY_REJECTED_MESSAGE: &str = "Host key verification failed: the host key is unknown \
     and unknown keys are rejected. An administrator must trust it under Known hosts or on the target's Security tab.";

/// Global tracker for per-user session counts. A `std` mutex so the slot can
/// be released synchronously from `Drop`.
static SESSION_COUNTS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, usize>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// One reserved per-user web terminal slot. Releasing on `Drop` means the
/// slot is returned on every exit path, including when the WebSocket upgrade
/// fails and the `on_upgrade` callback (which owns the guard) never runs.
struct SessionSlot {
    username: String,
}

impl SessionSlot {
    /// Reserve a slot for `username`, or `None` once the per-user limit is hit.
    fn acquire(username: &str) -> Option<Self> {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut counts = SESSION_COUNTS.lock().unwrap();
        let count = counts.entry(username.to_owned()).or_insert(0);
        if *count >= MAX_SESSIONS_PER_USER {
            return None;
        }
        *count += 1;
        Some(Self {
            username: username.to_owned(),
        })
    }
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut counts = SESSION_COUNTS.lock().unwrap();
        if let Some(count) = counts.get_mut(&self.username) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.username);
            }
        }
    }
}

#[derive(Deserialize)]
struct ResizeMessage {
    cols: u32,
    rows: u32,
}

#[derive(Serialize)]
struct StatusMessage {
    status: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<ConnectedDetails>,
}

#[derive(Serialize)]
struct HostKeyVerifyRequest {
    status: String,
    algorithm: String,
    key_base64: String,
    fingerprint: String,
    host: String,
    port: u16,
}

#[derive(Deserialize)]
struct HostKeyVerifyResponse {
    accepted: bool,
}

fn make_status_frame(status: &str, message: &str) -> Message {
    status_frame(StatusMessage {
        status: status.to_string(),
        message: message.to_string(),
        details: None,
    })
}

fn status_frame(msg: StatusMessage) -> Message {
    let json = serde_json::to_vec(&msg).unwrap_or_default();
    let mut frame = Vec::with_capacity(1 + json.len());
    frame.push(MSG_STATUS);
    frame.extend_from_slice(&json);
    Message::Binary(frame.into())
}

fn make_host_key_verify_frame(key: &PublicKey, host: &str, port: u16) -> Message {
    let msg = HostKeyVerifyRequest {
        status: "host_key_verify".to_string(),
        algorithm: key.algorithm().to_string(),
        key_base64: key.public_key_base64(),
        fingerprint: sha256_fingerprint(key),
        host: host.to_string(),
        port,
    };
    let json = serde_json::to_vec(&msg).unwrap_or_default();
    let mut frame = Vec::with_capacity(1 + json.len());
    frame.push(MSG_HOST_KEY_VERIFY);
    frame.extend_from_slice(&json);
    Message::Binary(frame.into())
}

pub(super) fn sha256_fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// Status message for a failed SSH connection, naming the reason; a changed
/// host key names both fingerprints.
pub(super) fn connection_error_message(err: &ConnectionError) -> String {
    let ConnectionError::HostKeyMismatch {
        received_key_base64,
        known_key_base64,
        ..
    } = err
    else {
        let reason = match err {
            ConnectionError::Resolve => "could not resolve the target host".to_string(),
            ConnectionError::Io(io) => match io.kind() {
                std::io::ErrorKind::ConnectionRefused => {
                    "connection refused by the target".to_string()
                }
                std::io::ErrorKind::TimedOut => "connection to the target timed out".to_string(),
                std::io::ErrorKind::HostUnreachable | std::io::ErrorKind::NetworkUnreachable => {
                    "target host unreachable".to_string()
                }
                _ => format!("network error: {io}"),
            },
            ConnectionError::Authentication => {
                "the target rejected the configured credentials".to_string()
            }
            ConnectionError::Key(_) => "could not load the SSH key for the target".to_string(),
            ConnectionError::Ssh(ssh) => format!("SSH protocol error: {ssh}"),
            ConnectionError::Aborted => "connection aborted".to_string(),
            ConnectionError::Internal | ConnectionError::HostKeyMismatch { .. } => {
                "internal error".to_string()
            }
        };
        return format!("SSH connection failed: {reason}");
    };
    let fingerprint = |key_base64: &str| {
        russh::keys::parse_public_key_base64(key_base64)
            .map(|key| sha256_fingerprint(&key))
            .unwrap_or_else(|_| "unparseable key".to_string())
    };
    format!(
        "Host key mismatch: the target presented {}, but the known host key is {}. \
         Verify the host before updating Known hosts.",
        fingerprint(received_key_base64),
        fingerprint(known_key_base64),
    )
}

async fn send_status(sink: &mut SplitSink<WebSocket, Message>, status: &str, message: &str) {
    let _ = sink.send(make_status_frame(status, message)).await;
}

/// Validate target_name: ASCII alphanumeric, hyphens, and dots only.
fn validate_target_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_TARGET_NAME_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// Extract username from request authorization.
fn extract_username(auth: Option<Data<RequestAuthorization>>) -> Option<String> {
    match auth.map(|a| a.0.clone()) {
        Some(RequestAuthorization::Session(SessionAuthorization::User(u))) => Some(u),
        Some(RequestAuthorization::Session(SessionAuthorization::Ticket { username, .. })) => {
            Some(username)
        }
        Some(RequestAuthorization::UserToken { username }) => Some(username),
        _ => None,
    }
}

/// Why a terminal or file manager request could not be resolved.
pub(super) enum ResolveError {
    Denied(&'static str),
    /// The account to sign in with could not be chosen (none picked or not allowed).
    Login(String),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(message) => f.write_str(message),
            Self::Login(message) => f.write_str(message),
        }
    }
}

/// Pick the login for a web connection; internal failures are logged.
pub(super) async fn select_login(
    db: &sea_orm::DatabaseConnection,
    target: &Target,
    username: &str,
    account: Option<&str>,
) -> Result<gated_core::account_credentials::TargetLogin, ResolveError> {
    use gated_core::account_credentials::LoginSelectionError;
    gated_core::account_credentials::select_login(db, target.id, username, account)
        .await
        .map_err(|e| match e {
            LoginSelectionError::Internal(e) => {
                error!(%e, "Failed to select the target account");
                ResolveError::Denied("Internal server error")
            }
            e => ResolveError::Login(e.to_string()),
        })
}

/// Resolve target and authorize user access. Returns (Target, SshOptions, UserInfo).
pub(super) async fn resolve_and_authorize(
    services: &Services,
    username: &str,
    target_name: &str,
    account: Option<&str>,
) -> Result<(Target, TargetSSHOptions, AuthStateUserInfo), ResolveError> {
    use ResolveError::Denied;
    let mut config_provider = services.config_provider.lock().await;

    let user = config_provider
        .get_user(username)
        .await
        .map_err(|e| {
            error!(%e, "Failed to load user");
            Denied("Internal server error")
        })?
        .ok_or(Denied("User not found"))?;

    let user_info = AuthStateUserInfo {
        id: user.id,
        username: username.to_owned(),
    };

    let authorized = config_provider
        .authorize_target(username, target_name)
        .await
        .map_err(|e| {
            error!(%e, "Authorization check failed");
            Denied("Internal server error")
        })?;

    if !authorized {
        return Err(Denied("Access denied to target"));
    }

    let target = config_provider
        .get_target(target_name)
        .await
        .map_err(|e| {
            error!(%e, "Failed to load target");
            Denied("Internal server error")
        })?
        .ok_or(Denied("Target not found"))?;

    if !matches!(target.options, TargetOptions::Ssh(_)) {
        return Err(Denied("Target is not an SSH target"));
    }

    // Apply the bound account's credentials onto the target's inline SSH
    // options (account overrides inline), exactly like the native SSH protocol
    // path (gated-protocol-ssh `ssh_options_with_account`). Without this the
    // web terminal ignores bound accounts and only uses the inline auth, so a
    // target with a password account but inline PublicKey auth fails with
    // "Authentication failed".
    let (ssh_options, account_id) = {
        let db = gated_core::db_required(&services.db).await.map_err(|e| {
            error!(%e, "Database unavailable");
            Denied("Internal server error")
        })?;
        let login = select_login(&db, &target, username, account).await?;
        gated_core::account_credentials::ssh_options_with_account(
            &db,
            &target,
            login,
            Some(username),
        )
        .await
        .map_err(|e| {
            error!(%e, "Failed to resolve SSH account credentials");
            Denied("Internal server error")
        })?
    };

    if let Some(account_id) = account_id
        && let Ok(db) = gated_core::db_required(&services.db).await
    {
        let _ = gated_core::account_credentials::update_account_last_used_at(&db, account_id).await;
    }

    Ok((target, ssh_options, user_info))
}

/// Prompt the user via WebSocket to accept/reject an unknown host key.
/// Returns true if the user accepts within the timeout, false otherwise.
async fn prompt_host_key_via_websocket(
    sink: &mut SplitSink<WebSocket, Message>,
    source: &mut futures::stream::SplitStream<WebSocket>,
    key: &PublicKey,
    host: &str,
    port: u16,
) -> bool {
    // Send host key info to browser
    if sink
        .send(make_host_key_verify_frame(key, host, port))
        .await
        .is_err()
    {
        return false;
    }

    // Wait for user response with timeout
    match tokio::time::timeout(HOST_KEY_VERIFY_TIMEOUT, async {
        while let Some(Ok(msg)) = source.next().await {
            if let Message::Binary(data) = msg
                && let Some((&MSG_HOST_KEY_VERIFY, payload)) = data.split_first()
                && let Ok(resp) = serde_json::from_slice::<HostKeyVerifyResponse>(payload)
            {
                return resp.accepted;
            }
        }
        false
    })
    .await
    {
        Ok(accepted) => accepted,
        Err(_) => {
            warn!("Host key verification timed out");
            false
        }
    }
}

/// Handle an unknown host key event based on the configured verification mode.
/// Returns true if the key was accepted, false if rejected.
async fn handle_host_key_verification(
    key: russh::keys::PublicKey,
    reply: tokio::sync::oneshot::Sender<bool>,
    host_key_mode: SshHostKeyVerificationMode,
    target: (&str, u16),
    sink: &mut SplitSink<WebSocket, Message>,
    source: &mut futures::stream::SplitStream<WebSocket>,
) -> bool {
    let accept = match host_key_mode {
        SshHostKeyVerificationMode::AutoAccept => {
            info!("Accepted untrusted host key (auto-accept is enabled)");
            true
        }
        SshHostKeyVerificationMode::AutoReject => {
            warn!("Rejected untrusted host key (auto-reject is enabled)");
            false
        }
        SshHostKeyVerificationMode::Prompt => {
            info!("Prompting user for host key verification via web terminal");
            send_status(
                sink,
                "info",
                "Verifying host key - please confirm in the dialog",
            )
            .await;
            prompt_host_key_via_websocket(sink, source, &key, target.0, target.1).await
        }
    };
    let _ = reply.send(accept);
    if !accept {
        let message = match host_key_mode {
            SshHostKeyVerificationMode::AutoReject => UNKNOWN_HOST_KEY_REJECTED_MESSAGE,
            _ => "Host key verification failed: the host key was rejected",
        };
        send_status(sink, "error", message).await;
    }
    accept
}

fn host_key_details(key: &PublicKey) -> HostKeyDetails {
    HostKeyDetails {
        algorithm: key.algorithm().to_string(),
        fingerprint: sha256_fingerprint(key),
    }
}

/// Wait for SSH connection and open a channel.
/// Returns the channel UUID and the target's host key on success.
async fn wait_for_connection(
    handles: &mut RemoteClientHandles,
    sink: &mut SplitSink<WebSocket, Message>,
    source: &mut futures::stream::SplitStream<WebSocket>,
    host_key_mode: SshHostKeyVerificationMode,
    target: (&str, u16),
) -> Option<(Uuid, Option<HostKeyDetails>)> {
    let mut host_key = None;
    loop {
        match handles.event_rx.recv().await {
            Some(RCEvent::State(RCState::Connected)) => {
                let ch_id = Uuid::new_v4();
                if handles
                    .command_tx
                    .send((RCCommand::Channel(ch_id, ChannelOperation::OpenShell), None))
                    .is_err()
                {
                    send_status(sink, "error", "Failed to open SSH channel").await;
                    return None;
                }
                return Some((ch_id, host_key));
            }
            Some(RCEvent::HostKeyReceived(key)) => {
                host_key = Some(host_key_details(&key));
            }
            Some(RCEvent::ConnectionError(err)) => {
                warn!(%err, "SSH connection failed");
                send_status(sink, "error", &connection_error_message(&err)).await;
                return None;
            }
            Some(RCEvent::Error(err)) => {
                warn!(%err, "SSH error during connection");
                send_status(sink, "error", "SSH connection error").await;
                return None;
            }
            Some(RCEvent::HostKeyUnknown(key, reply)) => {
                host_key = Some(host_key_details(&key));
                if !handle_host_key_verification(key, reply, host_key_mode, target, sink, source)
                    .await
                {
                    return None;
                }
            }
            None => {
                send_status(sink, "error", "SSH connection closed unexpectedly").await;
                return None;
            }
            _ => continue,
        }
    }
}

/// Send an SSH channel command checking for send failure.
async fn send_channel_command(
    handles: &mut RemoteClientHandles,
    sink: &mut SplitSink<WebSocket, Message>,
    channel_id: Uuid,
    operation: ChannelOperation,
    send_error_msg: &str,
    wait_error_msg: &str,
) -> bool {
    if handles
        .command_tx
        .send((RCCommand::Channel(channel_id, operation), None))
        .is_err()
    {
        send_status(sink, "error", send_error_msg).await;
        return false;
    }
    wait_for_success(handles, sink, channel_id, wait_error_msg).await
}

/// Establish SSH connection: connect, open channel, request PTY + shell.
/// Returns the channel UUID and the target's host key on success.
async fn establish_ssh_session(
    handles: &mut RemoteClientHandles,
    sink: &mut SplitSink<WebSocket, Message>,
    source: &mut futures::stream::SplitStream<WebSocket>,
    ssh_options: TargetSSHOptions,
    services: &Services,
) -> Option<(Uuid, Option<HostKeyDetails>)> {
    let (host, port) = (ssh_options.host.clone(), ssh_options.port);
    if handles
        .command_tx
        .send((RCCommand::Connect(ssh_options), None))
        .is_err()
    {
        send_status(sink, "error", "Failed to initiate SSH connection").await;
        return None;
    }

    let host_key_mode = services.config.read().await.store.ssh.host_key_verification;

    let (channel_id, host_key) =
        wait_for_connection(handles, sink, source, host_key_mode, (&host, port)).await?;

    // Note: OpenShell completes via the oneshot reply mechanism, not via RCEvent::Success.
    // The channel is ready to use immediately after wait_for_connection returns.

    // Request PTY
    if !send_channel_command(
        handles,
        sink,
        channel_id,
        ChannelOperation::RequestPty(PtyRequest {
            term: "xterm-256color".to_string(),
            col_width: 80,
            row_height: 24,
            pix_width: 0,
            pix_height: 0,
            modes: vec![],
        }),
        "Failed to request PTY",
        "Failed to allocate PTY",
    )
    .await
    {
        return None;
    }

    // Request shell
    if !send_channel_command(
        handles,
        sink,
        channel_id,
        ChannelOperation::RequestShell,
        "Failed to request shell",
        "Failed to start shell",
    )
    .await
    {
        return None;
    }

    Some((channel_id, host_key))
}

/// Wait for RCEvent::Success for the given channel_id, handling failures.
async fn wait_for_success(
    handles: &mut RemoteClientHandles,
    sink: &mut SplitSink<WebSocket, Message>,
    channel_id: Uuid,
    failure_msg: &str,
) -> bool {
    loop {
        match handles.event_rx.recv().await {
            Some(RCEvent::Success(id)) if id == channel_id => return true,
            Some(RCEvent::ChannelFailure(id)) if id == channel_id => {
                send_status(sink, "error", failure_msg).await;
                return false;
            }
            Some(RCEvent::ConnectionError(err)) => {
                warn!(%err, "SSH connection error");
                send_status(sink, "error", &connection_error_message(&err)).await;
                return false;
            }
            None => {
                send_status(sink, "error", "SSH connection closed").await;
                return false;
            }
            _ => continue,
        }
    }
}

/// Command control for a web terminal: lines are rebuilt from the keystrokes
/// and checked when Enter arrives, like the native PTY path.
struct CommandFilter {
    services: Services,
    session_id: Uuid,
    enforcer: DbCommandAclEnforcer,
    target_id: Uuid,
    target_name: String,
    user_id: Uuid,
    username: String,
    line: Vec<u8>,
}

impl CommandFilter {
    /// False when a line completed by `input` is denied or needs a review,
    /// which a web terminal cannot wait for.
    async fn accepts(&mut self, input: &[u8]) -> bool {
        for &byte in input {
            if byte != b'\n' && byte != b'\r' {
                self.line.push(byte);
                continue;
            }
            let line = std::mem::take(&mut self.line);
            let command = String::from_utf8_lossy(&line);
            let command = command.trim();
            if command.is_empty() {
                continue;
            }
            let decision = match self.enforcer.evaluate("ssh", command).await {
                Ok(decision) => decision,
                Err(error) => {
                    warn!(%error, session = %self.session_id, "Command-ACL rule load failed; forwarding command");
                    continue;
                }
            };
            let (acl_action, outcome) = match decision.action {
                AclAction::Allow => ("allow", "allowed"),
                AclAction::Deny => ("deny", "blocked"),
                AclAction::Review => ("review", "blocked-review-unsupported"),
            };
            let item = ShellCommandRecordingItem::Command {
                timestamp: chrono::Utc::now(),
                target: self.target_name.clone(),
                target_id: Some(self.target_id),
                user_id: Some(self.user_id),
                username: Some(self.username.clone()),
                origin: "web".to_string(),
                command: command.to_string(),
                acl_action: acl_action.to_string(),
                acl_rule_id: decision.rule_id,
                acl_rule_name: decision.rule_name.clone(),
                outcome: outcome.to_string(),
            };
            let metadata = ShellCommandSessionMetadata::SshShellSession {
                target: self.target_name.clone(),
                target_id: Some(self.target_id),
            };
            let recorder = self
                .services
                .recordings
                .lock()
                .await
                .start::<CommandAuditRecorder, _>(
                    &self.session_id,
                    Some("shell-commands".to_string()),
                    metadata,
                )
                .await;
            if let Ok(mut recorder) = recorder
                && let Err(error) = recorder.write_item(&item).await
            {
                debug!(%error, session = %self.session_id, "Failed to append shell-command audit item");
            }
            if decision.action != AclAction::Allow {
                warn!(session = %self.session_id, outcome, rule_id = ?decision.rule_id, "Web terminal command blocked by ACL policy");
                return false;
            }
        }
        true
    }
}

/// Run the bidirectional bridge between WebSocket and SSH channel,
/// with periodic WebSocket pings for keepalive.
async fn bridge_websocket_ssh(
    mut handles: RemoteClientHandles,
    sink: Arc<Mutex<SplitSink<WebSocket, Message>>>,
    mut source: futures::stream::SplitStream<WebSocket>,
    channel_id: Uuid,
    recorder: Option<TerminalRecorder>,
    close: Arc<tokio::sync::Notify>,
    mut command_filter: Option<CommandFilter>,
) -> bool {
    let had_input = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let input_seen = had_input.clone();
    let command_tx = handles.command_tx.clone();
    let close_command_tx = handles.command_tx.clone();
    let sink_clone = sink.clone();
    let blocked_sink = sink.clone();
    let blocked_close = close.clone();
    let recorder_ref = Arc::new(Mutex::new(recorder));
    let recorder_clone = recorder_ref.clone();

    // SSH output -> WebSocket
    let output_task = tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(WS_PING_INTERVAL);
        ping_interval.tick().await; // skip first immediate tick

        loop {
            tokio::select! {
                event = handles.event_rx.recv() => {
                    match event {
                        Some(RCEvent::Output(id, data)) if id == channel_id => {
                            if let Some(ref mut rec) = *recorder_clone.lock().await {
                                let _ = rec
                                    .write(TerminalRecordingStreamId::Output, &data)
                                    .await;
                            }
                            let mut frame = Vec::with_capacity(1 + data.len());
                            frame.push(MSG_TERMINAL_DATA);
                            frame.extend_from_slice(&data);
                            let mut s = sink_clone.lock().await;
                            if s.send(Message::Binary(frame.into())).await.is_err() {
                                break;
                            }
                        }
                        Some(RCEvent::ExtendedData { channel, data, ext: _ })
                            if channel == channel_id =>
                        {
                            if let Some(ref mut rec) = *recorder_clone.lock().await {
                                let _ = rec
                                    .write(TerminalRecordingStreamId::Error, &data)
                                    .await;
                            }
                            let mut frame = Vec::with_capacity(1 + data.len());
                            frame.push(MSG_TERMINAL_DATA);
                            frame.extend_from_slice(&data);
                            let mut s = sink_clone.lock().await;
                            if s.send(Message::Binary(frame.into())).await.is_err() {
                                break;
                            }
                        }
                        Some(RCEvent::Eof(id)) if id == channel_id => {
                            let mut s = sink_clone.lock().await;
                            let _ = s.send(make_status_frame("closed", "SSH session ended")).await;
                            break;
                        }
                        Some(RCEvent::Close(id)) if id == channel_id => {
                            let mut s = sink_clone.lock().await;
                            let _ = s.send(make_status_frame("closed", "SSH channel closed")).await;
                            break;
                        }
                        Some(RCEvent::ExitStatus(id, status)) if id == channel_id => {
                            let mut s = sink_clone.lock().await;
                            let _ = s
                                .send(make_status_frame(
                                    "closed",
                                    &format!("Exited with status {status}"),
                                ))
                                .await;
                            break;
                        }
                        Some(RCEvent::ConnectionError(err)) => {
                            warn!(%err, "SSH connection error during session");
                            let mut s = sink_clone.lock().await;
                            let _ = s
                                .send(make_status_frame("error", "SSH connection error"))
                                .await;
                            break;
                        }
                        None => break,
                        _ => {}
                    }
                }
                _ = ping_interval.tick() => {
                    let mut s = sink_clone.lock().await;
                    if s.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // WebSocket input -> SSH
    let input_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = source.next().await {
            match msg {
                Message::Binary(data) if !data.is_empty() => {
                    let Some((&msg_type, payload)) = data.split_first() else {
                        continue;
                    };
                    match msg_type {
                        MSG_TERMINAL_DATA => {
                            input_seen.store(true, std::sync::atomic::Ordering::Relaxed);
                            if let Some(ref mut rec) = *recorder_ref.lock().await {
                                let _ = rec.write(TerminalRecordingStreamId::Input, payload).await;
                            }
                            if let Some(filter) = command_filter.as_mut()
                                && !filter.accepts(payload).await
                            {
                                // The denied line is not sent; Ctrl-C drops what the shell has of it.
                                let _ = command_tx.send((
                                    RCCommand::Channel(
                                        channel_id,
                                        ChannelOperation::Data(Bytes::from_static(b"\x03")),
                                    ),
                                    None,
                                ));
                                let mut frame = vec![MSG_TERMINAL_DATA];
                                frame.extend_from_slice(b"\r\nCommand blocked by policy\r\n");
                                let _ = blocked_sink
                                    .lock()
                                    .await
                                    .send(Message::Binary(frame.into()))
                                    .await;
                                blocked_close.notify_one();
                                break;
                            }
                            if command_tx
                                .send((
                                    RCCommand::Channel(
                                        channel_id,
                                        ChannelOperation::Data(Bytes::copy_from_slice(payload)),
                                    ),
                                    None,
                                ))
                                .is_err()
                            {
                                break;
                            }
                        }
                        MSG_RESIZE => {
                            if let Ok(resize) = serde_json::from_slice::<ResizeMessage>(payload) {
                                if let Some(ref mut rec) = *recorder_ref.lock().await {
                                    let _ = rec.write_pty_resize(resize.cols, resize.rows).await;
                                }
                                let _ = command_tx.send((
                                    RCCommand::Channel(
                                        channel_id,
                                        ChannelOperation::ResizePty(PtyRequest {
                                            term: "xterm-256color".to_string(),
                                            col_width: resize.cols,
                                            row_height: resize.rows,
                                            pix_width: 0,
                                            pix_height: 0,
                                            modes: vec![],
                                        }),
                                    ),
                                    None,
                                ));
                            }
                        }
                        _ => {}
                    }
                }
                Message::Pong(_) => {}
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = command_tx.send((RCCommand::Disconnect, None));
    });

    let output_abort = output_task.abort_handle();
    let input_abort = input_task.abort_handle();
    tokio::select! {
        _ = output_task => {},
        _ = input_task => {},
        () = close.notified() => {
            output_abort.abort();
            input_abort.abort();
            let mut s = sink.lock().await;
            let _ = s.send(make_status_frame("closed", TERMINAL_CLOSED_MESSAGE)).await;
            let _ = s.close().await;
            let _ = close_command_tx.send((RCCommand::Disconnect, None));
        }
    }
    had_input.load(std::sync::atomic::Ordering::Relaxed)
}

pub async fn api_ssh_terminal(
    ws: WebSocketUpgrade,
    Path(target_name): Path<String>,
    Query(login): Query<LoginQuery>,
    services: Data<Services>,
    auth: Option<Data<RequestAuthorization>>,
) -> Response {
    let services = services.0;

    // Validate target_name before WebSocket upgrade
    if !validate_target_name(&target_name) {
        return (StatusCode::BAD_REQUEST, "Invalid target name").into_response();
    }

    // Check authentication BEFORE WebSocket upgrade
    if auth
        .as_ref()
        .is_some_and(|auth| !auth.permits_target(&target_name))
    {
        return (StatusCode::FORBIDDEN, "Ticket does not permit this target").into_response();
    }

    let ticket_id = match auth.as_deref() {
        Some(RequestAuthorization::Session(SessionAuthorization::Ticket { ticket_id, .. })) => {
            Some(*ticket_id)
        }
        _ => None,
    };
    let username = match extract_username(auth) {
        Some(u) => u,
        None => {
            warn!(
                target = %target_name,
                protocol = "ssh_terminal",
                "ssh_terminal_unauthenticated"
            );
            return (StatusCode::UNAUTHORIZED, "Not authenticated").into_response();
        }
    };

    // Check per-user session limit before upgrade. The guard moves into the
    // upgrade callback and is released when that future ends (or is dropped
    // without ever running).
    let Some(slot) = SessionSlot::acquire(&username) else {
        warn!(
            username = %username,
            target = %target_name,
            protocol = "ssh_terminal",
            "ssh_terminal_session_limit"
        );
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Too many concurrent terminal sessions",
        )
            .into_response();
    };

    upgrade(ws, move |socket| async move {
        let _slot = slot;
        let (mut sink, mut source) = socket.split();

        // Resolve target and authorize
        let (target, ssh_options, user_info) = match resolve_and_authorize(
            &services,
            &username,
            &target_name,
            login.account.as_deref(),
        )
        .await
        {
            Ok(v) => v,
            Err(msg) => {
                warn!(
                    username = %username,
                    target = %target_name,
                    protocol = "ssh_terminal",
                    reason = %msg,
                    "ssh_terminal_authorize_failed"
                );
                send_status(&mut sink, "error", &msg.to_string()).await;
                return;
            }
        };

        // Register session
        let close = Arc::new(tokio::sync::Notify::new());
        // A terminal opened with a ticket closes when the ticket is deleted
        // or expires.
        let _ticket_watch = ticket_id.map(|ticket_id| {
            let (services, close) = (services.clone(), close.clone());
            AbortOnDrop(tokio::spawn(async move {
                let mut interval = tokio::time::interval(TICKET_RECHECK_INTERVAL);
                loop {
                    interval.tick().await;
                    if let Ok(false) = gated_core::ticket_is_live(&services.db, &ticket_id).await {
                        close.notify_one();
                        return;
                    }
                }
            }))
        });
        let session_handle = match State::register_session(
            &services.state,
            &"WebSSH",
            SessionStateInit {
                remote_address: None,
                handle: Box::new(TerminalSessionHandle(close.clone())),
            },
        )
        .await
        {
            Ok(h) => h,
            Err(e) => {
                error!(%e, "Failed to register session");
                send_status(&mut sink, "error", "Internal server error").await;
                return;
            }
        };

        let session_id = session_handle.lock().await.id();
        let (acl_user_id, acl_username) = (user_info.id, user_info.username.clone());

        if let Some(ticket_id) = ticket_id {
            session_handle.lock().await.set_ticket(ticket_id).await;
        }
        if let Err(e) = session_handle.lock().await.set_user_info(user_info).await {
            error!(%e, "Failed to set user info");
        }
        if let Err(e) = session_handle.lock().await.set_target(&target).await {
            error!(%e, "Failed to set target");
        }

        // Create RemoteClient
        let mut handles = match RemoteClient::create(session_id, services.clone()) {
            Ok(h) => h,
            Err(e) => {
                error!(%e, "Failed to create SSH client");
                send_status(&mut sink, "error", "Internal server error").await;
                return;
            }
        };

        // Establish SSH session (connect, open channel, PTY, shell)
        // source is passed for interactive host key verification in Prompt mode
        let address = format!("{}:{}", ssh_options.host, ssh_options.port);
        let upstream_user = ssh_options.username.clone();
        let (channel_id, host_key) = match establish_ssh_session(
            &mut handles,
            &mut sink,
            &mut source,
            ssh_options,
            &services,
        )
        .await
        {
            Some(id) => id,
            None => {
                let _ = handles.abort_tx.send(());
                return;
            }
        };

        info!(
            %session_id,
            username = %username,
            target = %target.name,
            protocol = "ssh_terminal",
            "ssh_terminal_session_started"
        );
        session_handle.lock().await.audit_target_connected().await;
        let _ = sink
            .send(status_frame(StatusMessage {
                status: "connected".into(),
                message: "SSH session established".into(),
                details: Some(ConnectedDetails {
                    session_id: session_id.to_string(),
                    address,
                    username: upstream_user,
                    host_key,
                }),
            }))
            .await;

        // Start recording
        let recorder: Option<TerminalRecorder> = {
            let mut recordings = services.recordings.lock().await;
            match recordings
                .start::<TerminalRecorder, _>(
                    &session_id,
                    None,
                    SshRecordingMetadata::Shell { channel: 0 },
                )
                .await
            {
                Ok(r) => Some(r),
                Err(e) => {
                    debug!(%e, "Recording not available (may be disabled)");
                    None
                }
            }
        };

        // Bidirectional bridge with ping/pong keepalive
        let started = std::time::Instant::now();
        let sink = Arc::new(Mutex::new(sink));
        let command_filter = match services.db_required().await {
            Ok(db) => DbCommandAclEnforcer::new(db, target.id, acl_user_id)
                .await
                .map_err(
                    |error| error!(%error, "Failed to load the user's roles for command control"),
                )
                .ok(),
            Err(_) => None,
        }
        .map(|enforcer| CommandFilter {
            services: services.clone(),
            session_id,
            enforcer,
            target_id: target.id,
            target_name: target.name.clone(),
            user_id: acl_user_id,
            username: acl_username,
            line: Vec::new(),
        });
        let had_input = bridge_websocket_ssh(
            handles,
            sink,
            source,
            channel_id,
            recorder,
            close,
            command_filter,
        )
        .await;

        // Drop the empty session a short-lived socket leaves behind (StrictMode
        // double-mount in dev, reconnect churn) so the monitor isn't littered
        // with 0-second entries. A session the user typed into is kept.
        if !had_input && started.elapsed() < std::time::Duration::from_secs(2) {
            cleanup_empty_session(&services, session_id).await;
        }

        info!(
            %session_id,
            username = %username,
            target = %target.name,
            protocol = "ssh_terminal",
            duration_ms = started.elapsed().as_millis() as u64,
            "ssh_terminal_session_ended"
        );
    })
    .into_response()
}

/// Remove an empty terminal session (no output produced) together with its
/// recording rows/files, so the session monitor isn't littered with the
/// 0-second sessions a short-lived socket would otherwise leave behind.
pub(super) async fn cleanup_empty_session(services: &Services, session_id: uuid::Uuid) {
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    let Ok(db) = gated_core::db_required(&services.db).await else {
        return;
    };
    if let Ok(recs) = gated_db_entities::Recording::Entity::find()
        .filter(gated_db_entities::Recording::Column::SessionId.eq(session_id))
        .all(&db)
        .await
    {
        let recordings = services.recordings.lock().await;
        for r in &recs {
            let _ = recordings.remove(&session_id, &r.name).await;
        }
    }
    let _ = gated_db_entities::Recording::Entity::delete_many()
        .filter(gated_db_entities::Recording::Column::SessionId.eq(session_id))
        .exec(&db)
        .await;
    let _ = gated_db_entities::Session::Entity::delete_by_id(session_id)
        .exec(&db)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_is_released_when_the_guard_is_dropped() {
        let user = "slot-test-user";
        let mut held = Vec::new();
        for _ in 0..MAX_SESSIONS_PER_USER {
            held.push(SessionSlot::acquire(user).expect("slot available"));
        }
        assert!(SessionSlot::acquire(user).is_none());
        held.pop();
        assert!(SessionSlot::acquire(user).is_some());
        drop(held);
        #[allow(clippy::unwrap_used, reason = "test")]
        let counts = SESSION_COUNTS.lock().unwrap();
        // One guard from the `is_some()` check above was dropped immediately.
        assert!(!counts.contains_key(user));
    }

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIOKmUT3gMgD88/OWrzw95bmY8eaE/PFwlcwxCJ69JJgk";
    const KEY_A_FINGERPRINT: &str = "SHA256:rKO5+v6LQOKb1k7ygBP57PDXr6Kv9+6+eDEUpW46j9o";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIBB/1M1iDFuok7ZLVFAqOP/dIXiBGfnaAewhzNwZxCSB";
    const KEY_B_FINGERPRINT: &str = "SHA256:lhif+kPnT1h+GV3Pn+Lw6wA5iPY/1qZ+TPZeS7ucJBg";

    fn frame_json(message: Message) -> serde_json::Value {
        let Message::Binary(data) = message else {
            panic!("expected a binary frame");
        };
        assert_eq!(data[0], MSG_HOST_KEY_VERIFY);
        #[allow(clippy::unwrap_used, reason = "test")]
        serde_json::from_slice(&data[1..]).unwrap()
    }

    #[test]
    fn host_key_verify_frame_carries_fingerprint_and_target() {
        #[allow(clippy::unwrap_used, reason = "test")]
        let key = russh::keys::parse_public_key_base64(KEY_A).unwrap();
        let json = frame_json(make_host_key_verify_frame(&key, "ssh.example", 2222));
        assert_eq!(json["status"], "host_key_verify");
        assert_eq!(json["algorithm"], "ssh-ed25519");
        assert_eq!(json["key_base64"], KEY_A);
        assert_eq!(json["fingerprint"], KEY_A_FINGERPRINT);
        assert_eq!(json["host"], "ssh.example");
        assert_eq!(json["port"], 2222);
    }

    #[test]
    fn host_key_mismatch_names_both_fingerprints() {
        #[allow(clippy::unwrap_used, reason = "test")]
        let received = russh::keys::parse_public_key_base64(KEY_B).unwrap();
        let err = ConnectionError::HostKeyMismatch {
            received_key_type: received.algorithm(),
            received_key_base64: KEY_B.to_owned(),
            known_key_type: "ssh-ed25519".to_owned(),
            known_key_base64: KEY_A.to_owned(),
        };
        let message = connection_error_message(&err);
        assert!(message.starts_with("Host key mismatch"), "{message}");
        assert!(message.contains(KEY_B_FINGERPRINT), "{message}");
        assert!(message.contains(KEY_A_FINGERPRINT), "{message}");
    }

    #[test]
    fn connection_errors_name_the_reason() {
        let io = |kind| ConnectionError::Io(std::io::Error::from(kind));
        for (err, reason) in [
            (
                ConnectionError::Resolve,
                "could not resolve the target host",
            ),
            (
                io(std::io::ErrorKind::ConnectionRefused),
                "connection refused by the target",
            ),
            (
                io(std::io::ErrorKind::TimedOut),
                "connection to the target timed out",
            ),
            (
                io(std::io::ErrorKind::HostUnreachable),
                "target host unreachable",
            ),
            (
                ConnectionError::Authentication,
                "the target rejected the configured credentials",
            ),
        ] {
            assert_eq!(
                connection_error_message(&err),
                format!("SSH connection failed: {reason}")
            );
        }
    }

    #[test]
    fn auto_reject_message_points_to_known_hosts() {
        assert!(UNKNOWN_HOST_KEY_REJECTED_MESSAGE.contains("Known hosts"));
    }
}
