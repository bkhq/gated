use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use gated_common::auth::AuthStateUserInfo;
use gated_common::{SshHostKeyVerificationMode, Target, TargetOptions, TargetSSHOptions};
use gated_core::recordings::{TerminalRecorder, TerminalRecordingStreamId};
use gated_core::{ConfigProvider, Services, SessionStateInit, State};
use gated_protocol_ssh::{
    ChannelOperation, PtyRequest, RCCommand, RCEvent, RCState, RemoteClient, RemoteClientHandles,
    SshRecordingMetadata,
};
use poem::handler;
use poem::http::StatusCode;
use poem::web::websocket::{Message, WebSocket, WebSocketStream};
use poem::web::{Data, Path};
use poem::{IntoResponse, Request, Response};
use russh::keys::PublicKeyBase64;
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
const MSG_TERMINAL_DATA: u8 = 0x00;
const MSG_RESIZE: u8 = 0x01;
const MSG_STATUS: u8 = 0x02;
const MSG_HOST_KEY_VERIFY: u8 = 0x03;

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
}

#[derive(Serialize)]
struct HostKeyVerifyRequest {
    status: String,
    algorithm: String,
    key_base64: String,
}

#[derive(Deserialize)]
struct HostKeyVerifyResponse {
    accepted: bool,
}

fn make_status_frame(status: &str, message: &str) -> Message {
    let msg = StatusMessage {
        status: status.to_string(),
        message: message.to_string(),
    };
    let json = serde_json::to_vec(&msg).unwrap_or_default();
    let mut frame = Vec::with_capacity(1 + json.len());
    frame.push(MSG_STATUS);
    frame.extend_from_slice(&json);
    Message::Binary(frame)
}

fn make_host_key_verify_frame(algorithm: &str, key_base64: &str) -> Message {
    let msg = HostKeyVerifyRequest {
        status: "host_key_verify".to_string(),
        algorithm: algorithm.to_string(),
        key_base64: key_base64.to_string(),
    };
    let json = serde_json::to_vec(&msg).unwrap_or_default();
    let mut frame = Vec::with_capacity(1 + json.len());
    frame.push(MSG_HOST_KEY_VERIFY);
    frame.extend_from_slice(&json);
    Message::Binary(frame)
}

async fn send_status(sink: &mut SplitSink<WebSocketStream, Message>, status: &str, message: &str) {
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
fn extract_username(auth: Option<Data<&RequestAuthorization>>) -> Option<String> {
    match auth.map(|a| a.0.clone()) {
        Some(RequestAuthorization::Session(SessionAuthorization::User(u))) => Some(u),
        Some(RequestAuthorization::Session(SessionAuthorization::Ticket { username, .. })) => {
            Some(username)
        }
        Some(RequestAuthorization::UserToken { username }) => Some(username),
        _ => None,
    }
}

/// Resolve target and authorize user access. Returns (Target, SshOptions, UserInfo).
async fn resolve_and_authorize(
    services: &Services,
    username: &str,
    target_name: &str,
) -> Result<(Target, TargetSSHOptions, AuthStateUserInfo), &'static str> {
    let mut config_provider = services.config_provider.lock().await;

    let users = config_provider.list_users().await.map_err(|e| {
        error!(%e, "Failed to list users");
        "Internal server error"
    })?;

    let user = users
        .iter()
        .find(|u| u.username == username)
        .ok_or("User not found")?;

    let user_info = AuthStateUserInfo {
        id: user.id,
        username: username.to_owned(),
    };

    let authorized = config_provider
        .authorize_target(username, target_name)
        .await
        .map_err(|e| {
            error!(%e, "Authorization check failed");
            "Internal server error"
        })?;

    if !authorized {
        return Err("Access denied to target");
    }

    let targets = config_provider.list_targets().await.map_err(|e| {
        error!(%e, "Failed to list targets");
        "Internal server error"
    })?;

    let target = targets
        .into_iter()
        .find(|t| t.name == target_name)
        .ok_or("Target not found")?;

    if !matches!(target.options, TargetOptions::Ssh(_)) {
        return Err("Target is not an SSH target");
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
            "Internal server error"
        })?;
        gated_core::account_credentials::ssh_options_with_account(&db, &target, Some(username))
            .await
            .map_err(|e| {
                error!(%e, "Failed to resolve SSH account credentials");
                "Internal server error"
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
    sink: &mut SplitSink<WebSocketStream, Message>,
    source: &mut futures::stream::SplitStream<WebSocketStream>,
    algorithm: &str,
    key_base64: &str,
) -> bool {
    // Send host key info to browser
    if sink
        .send(make_host_key_verify_frame(algorithm, key_base64))
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
    sink: &mut SplitSink<WebSocketStream, Message>,
    source: &mut futures::stream::SplitStream<WebSocketStream>,
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
            let algorithm = format!("{}", key.algorithm());
            let key_base64 = key.public_key_base64();
            info!("Prompting user for host key verification via web terminal");
            send_status(
                sink,
                "info",
                "Verifying host key - please confirm in the dialog",
            )
            .await;
            prompt_host_key_via_websocket(sink, source, &algorithm, &key_base64).await
        }
    };
    let _ = reply.send(accept);
    if !accept {
        send_status(
            sink,
            "error",
            "Host key verification failed: unknown host key rejected",
        )
        .await;
    }
    accept
}

/// Wait for SSH connection and open a channel.
/// Returns the channel UUID on success.
async fn wait_for_connection(
    handles: &mut RemoteClientHandles,
    sink: &mut SplitSink<WebSocketStream, Message>,
    source: &mut futures::stream::SplitStream<WebSocketStream>,
    host_key_mode: SshHostKeyVerificationMode,
) -> Option<Uuid> {
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
                return Some(ch_id);
            }
            Some(RCEvent::ConnectionError(err)) => {
                warn!(%err, "SSH connection failed");
                send_status(sink, "error", "SSH connection failed").await;
                return None;
            }
            Some(RCEvent::Error(err)) => {
                warn!(%err, "SSH error during connection");
                send_status(sink, "error", "SSH connection error").await;
                return None;
            }
            Some(RCEvent::HostKeyUnknown(key, reply)) => {
                if !handle_host_key_verification(key, reply, host_key_mode, sink, source).await {
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
    sink: &mut SplitSink<WebSocketStream, Message>,
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
/// Returns the channel UUID on success.
async fn establish_ssh_session(
    handles: &mut RemoteClientHandles,
    sink: &mut SplitSink<WebSocketStream, Message>,
    source: &mut futures::stream::SplitStream<WebSocketStream>,
    ssh_options: TargetSSHOptions,
    services: &Services,
) -> Option<Uuid> {
    if handles
        .command_tx
        .send((RCCommand::Connect(ssh_options), None))
        .is_err()
    {
        send_status(sink, "error", "Failed to initiate SSH connection").await;
        return None;
    }

    let host_key_mode = services.config.read().await.store.ssh.host_key_verification;

    let channel_id = wait_for_connection(handles, sink, source, host_key_mode).await?;

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

    Some(channel_id)
}

/// Wait for RCEvent::Success for the given channel_id, handling failures.
async fn wait_for_success(
    handles: &mut RemoteClientHandles,
    sink: &mut SplitSink<WebSocketStream, Message>,
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
                send_status(sink, "error", "SSH connection failed").await;
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

/// Run the bidirectional bridge between WebSocket and SSH channel,
/// with periodic WebSocket pings for keepalive.
async fn bridge_websocket_ssh(
    mut handles: RemoteClientHandles,
    sink: Arc<Mutex<SplitSink<WebSocketStream, Message>>>,
    mut source: futures::stream::SplitStream<WebSocketStream>,
    channel_id: Uuid,
    recorder: Option<TerminalRecorder>,
    close: Arc<tokio::sync::Notify>,
) {
    let command_tx = handles.command_tx.clone();
    let close_command_tx = handles.command_tx.clone();
    let sink_clone = sink.clone();
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
                            if s.send(Message::Binary(frame)).await.is_err() {
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
                            if s.send(Message::Binary(frame)).await.is_err() {
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
                    if s.send(Message::Ping(Vec::new())).await.is_err() {
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
                            if let Some(ref mut rec) = *recorder_ref.lock().await {
                                let _ = rec.write(TerminalRecordingStreamId::Input, payload).await;
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
}

#[handler]
pub async fn api_ssh_terminal(
    req: &Request,
    ws: WebSocket,
    Path(target_name): Path<String>,
    services: Data<&Services>,
    auth: Option<Data<&RequestAuthorization>>,
) -> Response {
    let services = services.clone();

    // Reject cross-site WebSocket hijacking (CSWSH) before doing any work.
    if !crate::http_service::middleware::is_ws_origin_allowed(req, &services).await {
        warn!(
            target = %target_name,
            protocol = "ssh_terminal",
            "ssh_terminal_origin_rejected"
        );
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body("Invalid Origin");
    }

    // Validate target_name before WebSocket upgrade
    if !validate_target_name(&target_name) {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body("Invalid target name");
    }

    // Check authentication BEFORE WebSocket upgrade
    if auth
        .as_ref()
        .is_some_and(|auth| !auth.permits_target(&target_name))
    {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body("Ticket does not permit this target");
    }

    let username = match extract_username(auth) {
        Some(u) => u,
        None => {
            warn!(
                target = %target_name,
                protocol = "ssh_terminal",
                "ssh_terminal_unauthenticated"
            );
            return Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body("Not authenticated");
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
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .body("Too many concurrent terminal sessions");
    };

    ws.on_upgrade(move |socket| async move {
        let _slot = slot;
        let (mut sink, mut source) = socket.split();

        // Resolve target and authorize
        let (target, ssh_options, user_info) =
            match resolve_and_authorize(&services, &username, &target_name).await {
                Ok(v) => v,
                Err(msg) => {
                    warn!(
                        username = %username,
                        target = %target_name,
                        protocol = "ssh_terminal",
                        reason = %msg,
                        "ssh_terminal_authorize_failed"
                    );
                    send_status(&mut sink, "error", msg).await;
                    return;
                }
            };

        // Register session
        let close = Arc::new(tokio::sync::Notify::new());
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
        let channel_id = match establish_ssh_session(
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
        send_status(&mut sink, "connected", "SSH session established").await;

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
        bridge_websocket_ssh(handles, sink, source, channel_id, recorder, close).await;

        // Drop the empty session a short-lived socket leaves behind (StrictMode
        // double-mount in dev, reconnect churn) so the monitor isn't littered
        // with 0-second entries. A real interactive session outlives this.
        if started.elapsed() < std::time::Duration::from_secs(2) {
            crate::http_service::api::db_terminal::cleanup_empty_session(&services, session_id)
                .await;
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
}
