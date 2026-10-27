use std::borrow::Cow;
use std::collections::hash_map::Entry::Vacant;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::Poll;

use ansi_term::Colour;
use anyhow::{Context, Result};
use bimap::BiMap;
use bytes::Bytes;
use futures::{Future, FutureExt};
use gated_common::auth::{
    AuthCredential, AuthResult, AuthSelector, AuthState, AuthStateUserInfo, CredentialKind,
};
use gated_common::eventhub::{EventHub, EventSender, EventSubscription};
use gated_common::{
    GatedError, Secret, SessionId, SshHostKeyVerificationMode, Target, TargetOptions,
    TargetSSHOptions,
};
use gated_core::command_acl::{AclAction, AclContext, AclDecision, CommandAclRuleView, evaluate};
use gated_core::recordings::{
    self, CommandAuditRecorder, ConnectionRecorder, FileAuditRecorder, FileAuditRecordingItem,
    FileAuditSessionMetadata, ShellCommandRecordingItem, ShellCommandSessionMetadata,
    TerminalRecorder, TerminalRecordingStreamId, TrafficConnectionParams, TrafficRecorder,
};
use gated_core::{
    COMMAND_REVIEW_TIMEOUT, CommandReviewDecision, CommandReviewInfo, ConfigProvider,
    GatedServerHandle, Services, authorize_ticket, consume_ticket,
};
use gated_db_entities::CommandAclRule;
use russh::keys::{PublicKey, PublicKeyBase64};
use russh::{MethodKind, MethodSet, Sig};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::{Mutex, broadcast, oneshot};
use tracing::*;
use uuid::Uuid;

use super::channel_writer::ChannelWriter;
use super::russh_handler::ServerHandlerEvent;
use super::service_output::ServiceOutput;
use super::session_handle::SessionHandleCommand;
use crate::compat::ContextExt;
use crate::server::get_allowed_auth_methods;
use crate::server::service_output::ERASE_PROGRESS_SPINNER;
use crate::{
    ChannelOperation, ConnectionError, DirectTCPIPParams, PtyRequest, RCCommand, RCCommandReply,
    RCEvent, RCState, RemoteClient, ServerChannelId, SftpAuditor, SftpFileOperation,
    SshClientError, SshRecordingMetadata, X11Request,
};

#[derive(Clone)]
#[allow(clippy::large_enum_variant)]
enum TargetSelection {
    None,
    NotFound(String),
    Found(Target, TargetSSHOptions),
}

#[derive(Debug)]
enum Event {
    Command(SessionHandleCommand),
    ServerHandler(ServerHandlerEvent),
    ConsoleInput(Bytes),
    ServiceOutput(Bytes),
    Client(RCEvent),
}

enum KeyboardInteractiveState {
    None,
    OtpRequested,
    WebAuthRequested(broadcast::Receiver<AuthResult>),
}

struct CachedSuccessfulTicketAuth {
    ticket: Secret<String>,
    user_info: AuthStateUserInfo,
}

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
pub enum TrafficRecorderKey {
    Tcp(String, u32),
    Socket(String),
}

/// What to do with a command after consulting the command-ACL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AclFlow {
    /// Forward the command to the upstream target unchanged.
    Forward,
    /// Do not forward; block the command (deny, or fail-safe PTY review).
    Block,
}

/// Resolution of an `action=review` exec command once the paused session has an
/// admin decision (or the review timed out). Approve forwards the command;
/// reject and timeout both block it (fail-safe).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandReviewOutcome {
    Approved,
    Rejected,
    Timeout,
}

/// Map an [`AclDecision`] to a [`AclFlow`] for the PTY best-effort path. The
/// exec path does NOT use this — it drives `Review` through an interactive
/// pause/approve flow (see [`ServerSession::await_command_review`]).
///
/// `Review` maps to a fail-safe BLOCK here: pausing a raw interactive keystroke
/// stream mid-line cannot be done without corrupting the terminal, so PTY
/// review stays a fail-safe block (audit outcome `blocked-review-pending`).
fn apply_acl_decision(decision: &AclDecision) -> AclFlow {
    match decision.action {
        AclAction::Allow => AclFlow::Forward,
        AclAction::Deny => AclFlow::Block,
        // PTY review is not cleanly implementable (would corrupt the terminal
        // stream), so it fails safe and blocks; the guaranteed pause/approve
        // flow lives on the exec path only.
        AclAction::Review => AclFlow::Block,
    }
}

/// The `outcome` string recorded for a command on the PTY path given its
/// verdict. Deny and the PTY Review-as-block map to distinct outcomes so the
/// records API can tell an explicit deny from a fail-safe PTY review block. The
/// exec review path records its own resolved outcome (approved/rejected/
/// review-timeout) directly.
fn acl_outcome_label(action: AclAction) -> &'static str {
    match action {
        AclAction::Allow => "allowed",
        AclAction::Deny => "blocked",
        AclAction::Review => "blocked-review-pending",
    }
}

/// Map a `command_acl_rule` row into the DB-free [`CommandAclRuleView`] the
/// matcher consumes. Mirrors `gated-admin`'s loader but kept local so this
/// crate does not depend on gated-admin (columns map 1:1; entity id i32 ->
/// view id i64).
fn command_acl_rule_view(model: &CommandAclRule::Model) -> CommandAclRuleView {
    CommandAclRuleView {
        id: i64::from(model.id),
        name: model.name.clone(),
        enabled: model.enabled,
        priority: model.priority,
        protocol: model.protocol.clone(),
        match_type: model.match_type.clone(),
        pattern: model.pattern.clone(),
        action: model.action.clone(),
        target_id: model.target_id,
        role_id: model.role_id,
    }
}

pub struct ServerSession {
    pub id: SessionId,
    username: Option<String>,
    session_handle: Option<russh::server::Handle>,
    pty_channels: Vec<Uuid>,
    all_channels: Vec<Uuid>,
    channel_recorders: HashMap<Uuid, TerminalRecorder>,
    channel_map: BiMap<ServerChannelId, Uuid>,
    channel_pty_size_map: HashMap<Uuid, PtyRequest>,
    rc_tx: UnboundedSender<(RCCommand, Option<RCCommandReply>)>,
    rc_abort_tx: UnboundedSender<()>,
    rc_state: RCState,
    remote_address: SocketAddr,
    services: Services,
    server_handle: Arc<Mutex<GatedServerHandle>>,
    target: TargetSelection,
    traffic_recorders: HashMap<TrafficRecorderKey, TrafficRecorder>,
    traffic_connection_recorders: HashMap<Uuid, ConnectionRecorder>,
    hub: EventHub<Event>,
    event_sender: EventSender<Event>,
    main_event_subscription: EventSubscription<Event>,
    service_output: ServiceOutput,
    channel_writer: ChannelWriter,
    auth_state: Option<Arc<Mutex<AuthState>>>,
    keyboard_interactive_state: KeyboardInteractiveState,
    cached_successful_ticket_auth: Option<CachedSuccessfulTicketAuth>,
    allowed_auth_methods: MethodSet,
    /// While a host-key trust prompt is active, keystrokes are consumed as the
    /// y/n answer and must NOT be forwarded to the upstream target shell
    /// (otherwise the answer character leaks into the user's session).
    host_key_prompt_active: Arc<AtomicBool>,
    /// Per-PTY-channel raw input line buffer for best-effort interactive
    /// command-ACL reconstruction. See [`ServerSession::filter_pty_input`] for
    /// the (significant) limits of reconstructing commands from a byte stream.
    pty_input_buffers: HashMap<Uuid, Vec<u8>>,
    /// File-operation auditors for SFTP subsystem channels.
    sftp_auditors: HashMap<Uuid, SftpAuditor>,
    /// Role UUIDs held by the authenticated user, resolved once at auth time so
    /// role-scoped command-ACL rules match on SSH (parity with the DB proxies).
    /// Empty until authentication completes (and on a best-effort load failure).
    acl_role_ids: Vec<Uuid>,
    /// Authentication attempts of a connection that has not authenticated yet,
    /// audited once when it closes instead of recording a session.
    auth_attempts: Option<AuthAttempts>,
}

struct AuthAttempts {
    username: String,
    target: String,
    methods: BTreeSet<&'static str>,
}

fn session_debug_tag(id: &SessionId, remote_address: &SocketAddr) -> String {
    format!("[{id} - {remote_address}]")
}

/// Sanitize a client-supplied username before it is recorded into a tracing
/// span. The username arrives pre-authentication and is otherwise
/// emitted verbatim under the default text formatter, so control characters
/// (CR/LF, ANSI escape introducers, other C0/C1 controls) could forge log
/// lines or inject terminal escape sequences. Each control character is
/// replaced with the Unicode replacement character to neutralize it while
/// keeping the value legible.
fn sanitize_username(username: &str) -> String {
    username
        .chars()
        .map(|c| if c.is_control() { '\u{fffd}' } else { c })
        .collect()
}

impl std::fmt::Debug for ServerSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", session_debug_tag(&self.id, &self.remote_address))
    }
}

impl ServerSession {
    pub async fn start(
        remote_address: SocketAddr,
        services: &Services,
        server_handle: Arc<Mutex<GatedServerHandle>>,
        mut session_handle_rx: UnboundedReceiver<SessionHandleCommand>,
        mut handler_event_rx: UnboundedReceiver<ServerHandlerEvent>,
    ) -> Result<impl Future<Output = Result<()>> + use<>> {
        let id = server_handle.lock().await.id();

        let _span = info_span!("SSH", session=%id);
        let _enter = _span.enter();

        let mut rc_handles = RemoteClient::create(id, services.clone())?;

        let (hub, event_sender) = EventHub::setup();
        let main_event_subscription = hub
            .subscribe(|e| !matches!(e, Event::ConsoleInput(_)))
            .await;

        let mut this = Self {
            id,
            username: None,
            session_handle: None,
            pty_channels: vec![],
            all_channels: vec![],
            channel_recorders: HashMap::new(),
            channel_map: BiMap::new(),
            channel_pty_size_map: HashMap::new(),
            rc_tx: rc_handles.command_tx.clone(),
            rc_abort_tx: rc_handles.abort_tx,
            rc_state: RCState::NotInitialized,
            remote_address,
            services: services.clone(),
            server_handle,
            target: TargetSelection::None,
            traffic_recorders: HashMap::new(),
            traffic_connection_recorders: HashMap::new(),
            hub,
            event_sender: event_sender.clone(),
            main_event_subscription,
            service_output: ServiceOutput::new(),
            channel_writer: ChannelWriter::new(),
            auth_state: None,
            keyboard_interactive_state: KeyboardInteractiveState::None,
            cached_successful_ticket_auth: None,
            allowed_auth_methods: get_allowed_auth_methods(services).await?,
            host_key_prompt_active: Arc::new(AtomicBool::new(false)),
            pty_input_buffers: HashMap::new(),
            sftp_auditors: HashMap::new(),
            acl_role_ids: Vec::new(),
            auth_attempts: None,
        };

        let mut so_rx = this.service_output.subscribe();
        let so_sender = event_sender.clone();
        tokio::spawn(async move {
            loop {
                match so_rx.recv().await {
                    Ok(data) => {
                        if so_sender
                            .send_once(Event::ServiceOutput(data))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(_) => (),
                }
            }
        });

        let name = format!("SSH {id} session control");
        tokio::task::Builder::new().name(&name).spawn({
            let sender = event_sender.clone();
            async move {
                while let Some(command) = session_handle_rx.recv().await {
                    if sender.send_once(Event::Command(command)).await.is_err() {
                        break;
                    }
                }
            }
        })?;

        let name = format!("SSH {id} client events");
        tokio::task::Builder::new().name(&name).spawn({
            let sender = event_sender.clone();
            async move {
                while let Some(e) = rc_handles.event_rx.recv().await {
                    if sender.send_once(Event::Client(e)).await.is_err() {
                        break;
                    }
                }
            }
        })?;

        let name = format!("SSH {id} server handler events");
        tokio::task::Builder::new().name(&name).spawn({
            let sender: EventSender<Event> = event_sender.clone();
            async move {
                while let Some(e) = handler_event_rx.recv().await {
                    if sender.send_once(Event::ServerHandler(e)).await.is_err() {
                        break;
                    }
                }
            }
        })?;

        Ok(async move {
            while let Some(event) = this.get_next_event().await {
                this.handle_event(event).await?;
            }
            debug!("No more events");
            Ok::<_, anyhow::Error>(())
        })
    }

    async fn get_next_event(&mut self) -> Option<Event> {
        self.main_event_subscription.recv().await
    }

    async fn get_auth_state(&mut self, username: &str) -> Result<Arc<Mutex<AuthState>>> {
        #[allow(
            clippy::unwrap_used,
            reason = "as_ref().unwrap() is guarded by is_none() check on the same Option"
        )]
        if self.auth_state.is_none()
            || self
                .auth_state
                .as_ref()
                .unwrap()
                .lock()
                .await
                .user_info()
                .username
                != username
        {
            let state = self
                .services
                .auth_state_store
                .lock()
                .await
                .create(
                    Some(&self.id),
                    username,
                    crate::PROTOCOL_NAME,
                    &[
                        CredentialKind::Password,
                        CredentialKind::PublicKey,
                        CredentialKind::Totp,
                        CredentialKind::WebUserApproval,
                    ],
                )
                .await?
                .1;
            self.auth_state = Some(state);
        }
        #[allow(
            clippy::unwrap_used,
            reason = "the if-block above ensures auth_state is Some"
        )]
        Ok(self.auth_state.as_ref().cloned().unwrap())
    }

    pub fn make_logging_span(&self) -> tracing::Span {
        let client_ip = self.remote_address.ip().to_string();
        match self.username {
            Some(ref username) => {
                let username = sanitize_username(username);
                info_span!("SSH", session=%self.id, session_username=%username, %client_ip)
            }
            None => info_span!("SSH", session=%self.id, %client_ip),
        }
    }

    fn map_channel(&self, ch: &ServerChannelId) -> Result<Uuid, GatedError> {
        self.channel_map
            .get_by_left(ch)
            .cloned()
            .ok_or(GatedError::InconsistentState)
    }

    fn map_channel_reverse(&self, ch: &Uuid) -> Result<ServerChannelId> {
        self.channel_map
            .get_by_right(ch)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Channel not known"))
    }

    pub async fn emit_service_message(&mut self, msg: &str) -> Result<()> {
        debug!("Service message: {}", msg);

        self.service_output.emit_output(Bytes::from(format!(
            "{}{} {}\r\n",
            ERASE_PROGRESS_SPINNER,
            Colour::Black.on(Colour::White).paint(" Gated "),
            msg.replace('\n', "\r\n"),
        )));

        Ok(())
    }

    pub async fn emit_pty_output(&mut self, data: &[u8]) -> Result<()> {
        let channels = self.pty_channels.clone();
        for channel in channels {
            let channel = self.map_channel_reverse(&channel)?;
            if let Some(session) = self.session_handle.clone() {
                self.channel_writer
                    .write(session, channel.0, Bytes::copy_from_slice(data));
            }
        }
        Ok(())
    }

    /// Start connecting to the target if we aren't already.
    ///
    /// Timing of this call is important because if the client connection is
    /// an interactive session *in principle* (e.g a normal interactive OpenSSH
    /// session but maybe with some port forwards or agent)
    /// Ideally, it needs to be called by the time we already have the interactive
    /// channel open if we will ever have one to prevent bugs like
    /// https://github.com/bkhq/gated/issues/1286
    /// where a PTY channel is required for the host key prompt, but we've connected
    /// faster than the client could open one.
    pub async fn maybe_connect_remote(&mut self) -> Result<()> {
        match self.target.clone() {
            TargetSelection::None => {
                anyhow::bail!("Invalid session state (target not set)")
            }
            TargetSelection::NotFound(name) => {
                self.emit_service_message(&format!("Selected target not found: {name}"))
                    .await?;
                self.disconnect_server().await;
                anyhow::bail!("Target not found: {}", name);
            }
            TargetSelection::Found(target, ssh_options) => {
                if self.rc_state == RCState::NotInitialized {
                    self.connect_remote(target, ssh_options).await?;
                }
            }
        }
        Ok(())
    }

    async fn connect_remote(
        &mut self,
        target: Target,
        ssh_options: TargetSSHOptions,
    ) -> Result<()> {
        self.rc_state = RCState::Connecting;
        self.send_command(RCCommand::Connect(ssh_options))
            .map_err(|_| anyhow::anyhow!("cannot send command"))?;
        self.service_output.show_progress();
        self.emit_service_message(&format!("Selected target: {}", target.name))
            .await?;

        Ok(())
    }

    fn handle_event<'a>(
        &'a mut self,
        event: Event,
    ) -> Pin<Box<dyn Future<Output = Result<(), GatedError>> + Send + 'a>> {
        async move {
            match event {
                Event::Client(RCEvent::Done) => Err(GatedError::SessionEnd)?,
                Event::ServerHandler(ServerHandlerEvent::Disconnect) => {
                    Err(GatedError::SessionEnd)?
                }
                Event::Client(e) => {
                    debug!(event=?e, "Event");
                    let span = self.make_logging_span();
                    if let Err(err) = self.handle_remote_event(e).instrument(span).await {
                        error!("Client event handler error: {:?}", err);
                        // break;
                    }
                }
                Event::ServerHandler(e) => {
                    let span = self.make_logging_span();
                    if let Err(err) = self.handle_server_handler_event(e).instrument(span).await {
                        error!("Server event handler error: {:?}", err);
                        // break;
                    }
                }
                Event::Command(command) => {
                    debug!(?command, "Session control");
                    if let Err(err) = self.handle_session_control(command).await {
                        error!("Command handler error: {:?}", err);
                        // break;
                    }
                }
                Event::ServiceOutput(data) => {
                    let _ = self.emit_pty_output(&data).await;
                }
                Event::ConsoleInput(_) => (),
            }
            Ok(())
        }
        .boxed()
    }

    async fn handle_server_handler_event(&mut self, event: ServerHandlerEvent) -> Result<()> {
        match event {
            ServerHandlerEvent::Authenticated(handle) => {
                self.session_handle = Some(handle.0);
            }

            ServerHandlerEvent::ChannelOpenSession(server_channel_id, reply) => {
                let channel = Uuid::new_v4();
                self.channel_map.insert(server_channel_id, channel);

                info!(%channel, "Opening session channel");
                return match self
                    .send_command_and_wait(RCCommand::Channel(channel, ChannelOperation::OpenShell))
                    .await
                {
                    Ok(()) => {
                        self.all_channels.push(channel);
                        let _ = reply.send(true);
                        Ok(())
                    }
                    Err(SshClientError::Russh(russh::Error::ChannelOpenFailure(_))) => {
                        let _ = reply.send(false);
                        Ok(())
                    }
                    Err(x) => Err(x.into()),
                };
            }

            ServerHandlerEvent::SubsystemRequest(server_channel_id, name, reply) => {
                let is_sftp = name == "sftp";
                if is_sftp && !self.file_transfer_allowed().await {
                    let _ = reply.send(false);
                    return Ok(());
                }
                return match self
                    ._channel_subsystem_request(server_channel_id, name)
                    .await
                {
                    Ok(()) => {
                        if is_sftp && let Ok(channel_id) = self.map_channel(&server_channel_id) {
                            self.sftp_auditors.insert(channel_id, SftpAuditor::new());
                        }
                        let _ = reply.send(true);
                        Ok(())
                    }
                    Err(SshClientError::Russh(russh::Error::ChannelOpenFailure(_))) => {
                        let _ = reply.send(false);
                        Ok(())
                    }
                    Err(x) => Err(x.into()),
                };
            }

            ServerHandlerEvent::PtyRequest(server_channel_id, request, reply) => {
                let channel_id = self.map_channel(&server_channel_id)?;
                self.channel_pty_size_map
                    .insert(channel_id, request.clone());
                if let Some(recorder) = self.channel_recorders.get_mut(&channel_id)
                    && let Err(error) = recorder
                        .write_pty_resize(request.col_width, request.row_height)
                        .await
                {
                    error!(%channel_id, ?error, "Failed to record terminal data");
                    self.channel_recorders.remove(&channel_id);
                }
                self.send_command_and_wait(RCCommand::Channel(
                    channel_id,
                    ChannelOperation::RequestPty(request),
                ))
                .await?;
                let _ = self
                    .session_handle
                    .as_mut()
                    .context("Invalid session state")?
                    .channel_success(server_channel_id.0)
                    .await;
                self.pty_channels.push(channel_id);
                let _ = reply.send(());
            }

            ServerHandlerEvent::ShellRequest(server_channel_id, reply) => {
                let channel_id = self.map_channel(&server_channel_id)?;
                let _ = self.maybe_connect_remote().await;

                let _ = self.send_command(RCCommand::Channel(
                    channel_id,
                    ChannelOperation::RequestShell,
                ));

                self.start_terminal_recording(
                    channel_id,
                    SshRecordingMetadata::Shell {
                        // HACK russh ChannelId is opaque except via Display
                        channel: server_channel_id.0.to_string().parse().unwrap_or_default(),
                    },
                )
                .await;

                info!(%channel_id, "Opening shell");

                let _ = self
                    .session_handle
                    .as_mut()
                    .context("Invalid session state")?
                    .channel_success(server_channel_id.0)
                    .await;

                let _ = reply.send(true);
            }

            ServerHandlerEvent::AuthPublicKey(username, key, reply) => {
                let _ = reply.send(self._auth_publickey(username, key).await);
            }

            ServerHandlerEvent::AuthPublicKeyOffer(username, key, reply) => {
                let _ = reply.send(self._auth_publickey_offer(username, key).await);
            }

            ServerHandlerEvent::AuthPassword(username, password, reply) => {
                let _ = reply.send(self._auth_password(username, password).await);
            }

            ServerHandlerEvent::AuthKeyboardInteractive(username, response, reply) => {
                let _ = reply.send(self._auth_keyboard_interactive(username, response).await);
            }

            ServerHandlerEvent::Data(channel, data, reply) => {
                self._data(channel, data).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::ExtendedData(channel, data, code, reply) => {
                self._extended_data(channel, code, data).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::ChannelClose(channel, reply) => {
                self._channel_close(channel).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::ChannelEof(channel, reply) => {
                self._channel_eof(channel).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::WindowChangeRequest(channel, request, reply) => {
                self._window_change_request(channel, request).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::Signal(channel, signal, reply) => {
                self._channel_signal(channel, signal).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::ExecRequest(channel, data, reply) => {
                self._channel_exec_request(channel, data).await?;
                let _ = reply.send(true);
            }

            ServerHandlerEvent::ChannelOpenDirectTcpIp(channel, params, reply) => {
                let _ = reply.send(self._channel_open_direct_tcpip(channel, params).await?);
            }

            ServerHandlerEvent::ChannelOpenDirectStreamlocal(channel, path, reply) => {
                let _ = reply.send(self._channel_open_direct_streamlocal(channel, path).await?);
            }

            ServerHandlerEvent::EnvRequest(channel, name, value, reply) => {
                self._channel_env_request(channel, name, value).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::X11Request(channel, request, reply) => {
                self._channel_x11_request(channel, request).await?;
                let _ = reply.send(());
            }

            ServerHandlerEvent::TcpIpForward(address, port, reply) => {
                self._tcpip_forward(address, port).await?;
                let _ = reply.send(true);
            }

            ServerHandlerEvent::CancelTcpIpForward(address, port, reply) => {
                self._cancel_tcpip_forward(address, port).await?;
                let _ = reply.send(true);
            }

            ServerHandlerEvent::StreamlocalForward(socket_path, reply) => {
                self._streamlocal_forward(socket_path).await?;
                let _ = reply.send(true);
            }

            ServerHandlerEvent::CancelStreamlocalForward(socket_path, reply) => {
                self._cancel_streamlocal_forward(socket_path).await?;
                let _ = reply.send(true);
            }

            ServerHandlerEvent::AgentForward(channel, reply) => {
                self._agent_forward(channel).await?;
                let _ = reply.send(true);
            }

            ServerHandlerEvent::Disconnect => (),
        }

        Ok(())
    }

    pub async fn handle_session_control(&mut self, command: SessionHandleCommand) -> Result<()> {
        match command {
            SessionHandleCommand::Close => {
                let _ = self.emit_service_message("Session closed by admin").await;
                info!("Session closed by admin");
                self.request_disconnect().await;
                self.disconnect_server().await;
            }
        }
        Ok(())
    }

    pub async fn handle_remote_event(&mut self, event: RCEvent) -> Result<()> {
        match event {
            RCEvent::State(state) => {
                self.rc_state = state;
                match &self.rc_state {
                    RCState::Connected => {
                        self.server_handle
                            .lock()
                            .await
                            .audit_target_connected()
                            .await;
                        self.service_output.hide_progress().await;
                        self.service_output.emit_output(Bytes::from(format!(
                            "{}{}\r\n",
                            ERASE_PROGRESS_SPINNER,
                            Colour::Black.on(Colour::Green).paint(" ✓ Gated connected ")
                        )));
                    }
                    RCState::Disconnected => {
                        self.service_output.hide_progress().await;
                        self.disconnect_server().await;
                    }
                    _ => {}
                }
            }
            RCEvent::ConnectionError(error) => {
                self.service_output.hide_progress().await;

                match error {
                    ConnectionError::HostKeyMismatch {
                        received_key_type,
                        received_key_base64,
                        known_key_type,
                        known_key_base64,
                    } => {
                        let msg = format!(
                            concat!(
                                "Host key doesn't match the stored one.\n",
                                "Stored key   ({}): {}\n",
                                "Received key ({}): {}",
                            ),
                            known_key_type,
                            known_key_base64,
                            received_key_type,
                            received_key_base64
                        );
                        self.emit_service_message(&msg).await?;
                        self.emit_service_message(
                            "If you know that the key is correct (e.g. it has been changed),",
                        )
                        .await?;
                        self.emit_service_message(
                            "you can remove the old key in the Gated management UI and try again",
                        )
                        .await?;
                    }
                    ConnectionError::Authentication => {
                        self.service_output.emit_output(Bytes::from(format!(
                            "{}{}\r\n",
                            ERASE_PROGRESS_SPINNER,
                            Colour::Black
                                .on(Colour::Red)
                                .paint(" ✗ SSH target rejected Gated authentication request ")
                        )));
                    }
                    error => {
                        self.service_output.emit_output(Bytes::from(format!(
                            "{}{} {}\r\n",
                            ERASE_PROGRESS_SPINNER,
                            Colour::Black.on(Colour::Red).paint(" ✗ Connection failed "),
                            error
                        )));
                    }
                }
            }
            RCEvent::Error(e) => {
                self.service_output.hide_progress().await;
                let _ = self.emit_service_message(&format!("Error: {e}")).await;
                self.disconnect_server().await;
            }
            RCEvent::Output(channel, data) => {
                if let Some(recorder) = self.channel_recorders.get_mut(&channel)
                    && let Err(error) = recorder
                        .write(TerminalRecordingStreamId::Output, &data)
                        .await
                {
                    error!(%channel, ?error, "Failed to record terminal data");
                    self.channel_recorders.remove(&channel);
                }

                if let Some(recorder) = self.traffic_connection_recorders.get_mut(&channel)
                    && let Err(error) = recorder.write_rx(&data).await
                {
                    error!(%channel, ?error, "Failed to record traffic data");
                    self.traffic_connection_recorders.remove(&channel);
                }

                if let Some(auditor) = self.sftp_auditors.get_mut(&channel) {
                    let operations = auditor.server_data(&data);
                    self.record_file_operations(operations).await;
                }

                let server_channel_id = self.map_channel_reverse(&channel)?;
                if let Some(session) = self.session_handle.clone() {
                    self.channel_writer.write(
                        session,
                        server_channel_id.0,
                        Bytes::copy_from_slice(&data),
                    );
                }
            }
            RCEvent::Success(channel) => {
                let server_channel_id = self.map_channel_reverse(&channel)?;
                self.maybe_with_session(|handle| async move {
                    handle
                        .channel_success(server_channel_id.0)
                        .await
                        .context("failed to send data")
                })
                .await?;
            }
            RCEvent::ChannelFailure(channel) => {
                let server_channel_id = self.map_channel_reverse(&channel)?;
                self.maybe_with_session(|handle| async move {
                    handle
                        .channel_failure(server_channel_id.0)
                        .await
                        .context("failed to send data")
                })
                .await?;
            }
            RCEvent::Close(channel) => {
                // Flush any pending writes before closing the channel
                let _ = self.channel_writer.flush().await;

                let server_channel_id = self.map_channel_reverse(&channel)?;
                let _ = self
                    .maybe_with_session(|handle| async move {
                        handle
                            .close(server_channel_id.0)
                            .await
                            .context("failed to close ch")
                    })
                    .await;
                self.finish_sftp_audit(&channel).await;
                self.remove_channel(&channel);
            }
            RCEvent::Eof(channel) => {
                // Flush any pending writes before sending EOF
                let _ = self.channel_writer.flush().await;

                let server_channel_id = self.map_channel_reverse(&channel)?;
                self.maybe_with_session(|handle| async move {
                    handle
                        .eof(server_channel_id.0)
                        .await
                        .context("failed to send eof")
                })
                .await?;
            }
            RCEvent::ExitStatus(channel, code) => {
                // Flush any pending writes before sending exit status
                let _ = self.channel_writer.flush().await;

                let server_channel_id = self.map_channel_reverse(&channel)?;
                self.maybe_with_session(|handle| async move {
                    handle
                        .exit_status_request(server_channel_id.0, code)
                        .await
                        .context("failed to send exit status")
                })
                .await?;
            }
            RCEvent::ExitSignal {
                channel,
                signal_name,
                core_dumped,
                error_message,
                lang_tag,
            } => {
                let server_channel_id = self.map_channel_reverse(&channel)?;
                self.maybe_with_session(|handle| async move {
                    handle
                        .exit_signal_request(
                            server_channel_id.0,
                            signal_name,
                            core_dumped,
                            error_message,
                            lang_tag,
                        )
                        .await
                        .context("failed to send exit status")?;
                    Ok(())
                })
                .await?;
            }
            RCEvent::Done => {}
            RCEvent::ExtendedData { channel, data, ext } => {
                if let Some(recorder) = self.channel_recorders.get_mut(&channel)
                    && let Err(error) = recorder
                        .write(TerminalRecordingStreamId::Error, &data)
                        .await
                {
                    error!(%channel, ?error, "Failed to record session data");
                    self.channel_recorders.remove(&channel);
                }
                let server_channel_id = self.map_channel_reverse(&channel)?;
                if let Some(session) = self.session_handle.clone() {
                    self.channel_writer.write_extended(
                        session,
                        server_channel_id.0,
                        ext,
                        Bytes::copy_from_slice(&data),
                    );
                }
            }
            RCEvent::HostKeyReceived(key) => {
                self.emit_service_message(&format!(
                    "Host key ({}): {}",
                    key.algorithm(),
                    key.public_key_base64()
                ))
                .await?;
            }
            RCEvent::HostKeyUnknown(key, reply) => {
                self.handle_unknown_host_key(key, reply).await?;
            }
            RCEvent::ForwardedTcpIp(id, params) => {
                if let Some(session) = &mut self.session_handle {
                    let server_channel = session
                        .channel_open_forwarded_tcpip(
                            params.connected_address,
                            params.connected_port,
                            params.originator_address.clone(),
                            params.originator_port,
                        )
                        .await?;

                    self.channel_map
                        .insert(ServerChannelId(server_channel.id()), id);
                    self.all_channels.push(id);

                    let recorder = self
                        .traffic_recorder_for(
                            TrafficRecorderKey::Tcp(
                                params.originator_address.clone(),
                                params.originator_port,
                            ),
                            SshRecordingMetadata::ForwardedTcpIp {
                                host: params.originator_address,
                                port: params.originator_port as u16,
                            },
                        )
                        .await;
                    if let Some(recorder) = recorder {
                        #[allow(
                            clippy::unwrap_used,
                            reason = "static Ipv4Addr literal is known-valid"
                        )]
                        let mut recorder = recorder.connection(TrafficConnectionParams::Tcp {
                            dst_addr: Ipv4Addr::from_str("2.2.2.2").unwrap(),
                            dst_port: params.connected_port as u16,
                            src_addr: Ipv4Addr::from_str("1.1.1.1").unwrap(),
                            src_port: params.originator_port as u16,
                        });
                        if let Err(error) = recorder.write_connection_setup().await {
                            error!(channel=%id, ?error, "Failed to record connection setup");
                        }
                        self.traffic_connection_recorders.insert(id, recorder);
                    }
                }
            }
            RCEvent::ForwardedStreamlocal(id, params) => {
                if let Some(session) = &mut self.session_handle {
                    let server_channel = session
                        .channel_open_forwarded_streamlocal(params.socket_path.clone())
                        .await?;

                    self.channel_map
                        .insert(ServerChannelId(server_channel.id()), id);
                    self.all_channels.push(id);

                    let recorder = self
                        .traffic_recorder_for(
                            TrafficRecorderKey::Socket(params.socket_path.clone()),
                            SshRecordingMetadata::ForwardedSocket {
                                path: params.socket_path.clone(),
                            },
                        )
                        .await;
                    if let Some(recorder) = recorder {
                        #[allow(
                            clippy::unwrap_used,
                            reason = "static Ipv4Addr literal is known-valid"
                        )]
                        let mut recorder = recorder.connection(TrafficConnectionParams::Socket {
                            socket_path: params.socket_path,
                        });
                        if let Err(error) = recorder.write_connection_setup().await {
                            error!(channel=%id, ?error, "Failed to record connection setup");
                        }
                        self.traffic_connection_recorders.insert(id, recorder);
                    }
                }
            }
            RCEvent::ForwardedAgent(id) => {
                if let Some(session) = &mut self.session_handle {
                    let server_channel = session.channel_open_agent().await?;

                    self.channel_map
                        .insert(ServerChannelId(server_channel.id()), id);
                    self.all_channels.push(id);
                }
            }
            RCEvent::X11(id, originator_address, originator_port) => {
                if let Some(session) = &mut self.session_handle {
                    let server_channel = session
                        .channel_open_x11(originator_address, originator_port)
                        .await?;

                    self.channel_map
                        .insert(ServerChannelId(server_channel.id()), id);
                    self.all_channels.push(id);
                }
            }
        }
        Ok(())
    }

    async fn handle_unknown_host_key(
        &mut self,
        key: PublicKey,
        reply: oneshot::Sender<bool>,
    ) -> Result<()> {
        self.service_output.hide_progress().await;

        let mode = self
            .services
            .config
            .read()
            .await
            .store
            .ssh
            .host_key_verification;

        if mode == SshHostKeyVerificationMode::AutoAccept {
            let _ = reply.send(true);
            info!(target: "audit","Accepted untrusted host key (auto-accept is enabled)");
            return Ok(());
        }

        if mode == SshHostKeyVerificationMode::AutoReject {
            let _ = reply.send(false);
            info!(target: "audit","Rejected untrusted host key (auto-reject is enabled)");
            return Ok(());
        }

        if self.pty_channels.is_empty() {
            warn!(
                "Target host key is not trusted, but there is no active PTY channel to show the trust prompt on."
            );
            warn!(
                "Connect to this target with an interactive session once to accept the host key."
            );
            self.request_disconnect().await;
            anyhow::bail!("No PTY channel to show an interactive prompt on")
        }

        self.emit_service_message(&format!(
            "There is no trusted {} key for this host.",
            key.algorithm()
        ))
        .await?;
        self.emit_service_message("Trust this key? (y/n)").await?;

        let mut sub = self
            .hub
            .subscribe(|e| matches!(e, Event::ConsoleInput(_)))
            .await;

        let mut service_output = self.service_output.clone();
        let prompt_active = self.host_key_prompt_active.clone();
        prompt_active.store(true, Ordering::SeqCst);
        tokio::spawn(async move {
            loop {
                match sub.recv().await {
                    Some(Event::ConsoleInput(data)) => {
                        // Match the first printable (non-whitespace, non-control) byte:
                        // ssh clients running with `-tt` or through expect batch the
                        // keystroke with a trailing CR/LF, so plain "y" / "n" equality
                        // never matched and the prompt timed out.
                        let answer = data
                            .iter()
                            .copied()
                            .find(|b| !b.is_ascii_whitespace() && !b.is_ascii_control())
                            .map(|b| b.to_ascii_lowercase());
                        match answer {
                            Some(b'y') => {
                                let _ = reply.send(true);
                                break;
                            }
                            Some(b'n') => {
                                let _ = reply.send(false);
                                break;
                            }
                            _ => {}
                        }
                    }
                    None => break,
                    _ => (),
                }
            }
            prompt_active.store(false, Ordering::SeqCst);
            service_output.show_progress();
        });

        Ok(())
    }

    async fn maybe_with_session<'a, FN, FT, R>(&'a mut self, f: FN) -> Result<Option<R>>
    where
        FN: FnOnce(&'a mut russh::server::Handle) -> FT + 'a,
        FT: futures::Future<Output = Result<R>>,
    {
        if let Some(handle) = &mut self.session_handle {
            return Ok(Some(f(handle).await?));
        }
        Ok(None)
    }

    async fn _channel_open_direct_tcpip(
        &mut self,
        channel: ServerChannelId,
        params: DirectTCPIPParams,
    ) -> Result<bool> {
        let uuid = Uuid::new_v4();
        self.channel_map.insert(channel, uuid);

        info!(%channel, "Opening direct TCP/IP channel from {}:{} to {}:{}", params.originator_address, params.originator_port, params.host_to_connect, params.port_to_connect);

        let _ = self.maybe_connect_remote().await;

        match self
            .send_command_and_wait(RCCommand::Channel(
                uuid,
                ChannelOperation::OpenDirectTCPIP(params.clone()),
            ))
            .await
        {
            Ok(()) => {
                self.all_channels.push(uuid);

                let recorder = self
                    .traffic_recorder_for(
                        TrafficRecorderKey::Tcp(
                            params.host_to_connect.clone(),
                            params.port_to_connect,
                        ),
                        SshRecordingMetadata::DirectTcpIp {
                            host: params.host_to_connect,
                            port: params.port_to_connect as u16,
                        },
                    )
                    .await;
                if let Some(recorder) = recorder {
                    #[allow(clippy::unwrap_used, reason = "static Ipv4Addr literal is known-valid")]
                    let mut recorder = recorder.connection(TrafficConnectionParams::Tcp {
                        dst_addr: Ipv4Addr::from_str("2.2.2.2").unwrap(),
                        dst_port: params.port_to_connect as u16,
                        src_addr: Ipv4Addr::from_str("1.1.1.1").unwrap(),
                        src_port: params.originator_port as u16,
                    });
                    if let Err(error) = recorder.write_connection_setup().await {
                        error!(%channel, ?error, "Failed to record connection setup");
                    }
                    self.traffic_connection_recorders.insert(uuid, recorder);
                }

                Ok(true)
            }
            Err(SshClientError::Russh(russh::Error::ChannelOpenFailure(_))) => Ok(false),
            Err(x) => Err(x.into()),
        }
    }

    async fn _channel_open_direct_streamlocal(
        &mut self,
        channel: ServerChannelId,
        path: String,
    ) -> Result<bool> {
        let uuid = Uuid::new_v4();
        self.channel_map.insert(channel, uuid);

        info!(%channel, "Opening direct streamlocal channel to {}", path);

        let _ = self.maybe_connect_remote().await;

        match self
            .send_command_and_wait(RCCommand::Channel(
                uuid,
                ChannelOperation::OpenDirectStreamlocal(path.clone()),
            ))
            .await
        {
            Ok(()) => {
                self.all_channels.push(uuid);

                let recorder = self
                    .traffic_recorder_for(
                        TrafficRecorderKey::Socket(path.clone()),
                        SshRecordingMetadata::DirectSocket { path: path.clone() },
                    )
                    .await;
                if let Some(recorder) = recorder {
                    #[allow(clippy::unwrap_used, reason = "static Ipv4Addr literal is known-valid")]
                    let mut recorder =
                        recorder.connection(TrafficConnectionParams::Socket { socket_path: path });
                    if let Err(error) = recorder.write_connection_setup().await {
                        error!(%channel, ?error, "Failed to record connection setup");
                    }
                    self.traffic_connection_recorders.insert(uuid, recorder);
                }

                Ok(true)
            }
            Err(SshClientError::Russh(russh::Error::ChannelOpenFailure(_))) => Ok(false),
            Err(x) => Err(x.into()),
        }
    }

    async fn _window_change_request(
        &mut self,
        server_channel_id: ServerChannelId,
        request: PtyRequest,
    ) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        self.channel_pty_size_map
            .insert(channel_id, request.clone());
        if let Some(recorder) = self.channel_recorders.get_mut(&channel_id)
            && let Err(error) = recorder
                .write_pty_resize(request.col_width, request.row_height)
                .await
        {
            error!(%channel_id, ?error, "Failed to record terminal data");
            self.channel_recorders.remove(&channel_id);
        }
        self.send_command_and_wait(RCCommand::Channel(
            channel_id,
            ChannelOperation::ResizePty(request),
        ))
        .await?;
        Ok(())
    }

    /// Load all enabled command-ACL rules for evaluation.
    ///
    /// Returns `Err` (with a human-readable reason) on a rule-LOAD failure so the
    /// caller can fail-*open* uniformly: emit a WARN + one degraded-control audit
    /// record and forward the command. This fail-open is deliberate and scoped —
    /// the feature is OFF by default (an unconfigured deployment has no rules),
    /// so a transient DB blip must not brick every shell — and it mirrors the DB
    /// proxies. The fail-*safe* guarantee applies to *verdicts*: a Deny/Review
    /// that is actually evaluated always blocks. `Ok(empty)` means the ruleset is
    /// genuinely empty (default-allow), which is distinct from a load error.
    async fn load_command_acl_rules(&self) -> Result<Vec<CommandAclRuleView>, String> {
        let db = gated_core::db_required(&self.services.db)
            .await
            .map_err(|err| format!("db unavailable: {err}"))?;
        let rows = CommandAclRule::Entity::find()
            .filter(CommandAclRule::Column::Enabled.eq(true))
            .all(&db)
            .await
            .map_err(|err| format!("rule query failed: {err}"))?;
        Ok(rows.iter().map(command_acl_rule_view).collect())
    }

    /// Emit exactly one shell-command audit record noting that command control is
    /// degraded (fail-open) because the ACL ruleset could not be loaded. Keeps the
    /// degraded state observable/auditable, mirroring the DB proxies' degraded
    /// audit event.
    async fn record_degraded_command(
        &self,
        origin: &str,
        command: &str,
        target_id: Option<Uuid>,
        target_name: &str,
    ) {
        let decision = AclDecision {
            action: AclAction::Allow,
            rule_id: None,
            rule_name: None,
        };
        self.record_shell_command(
            origin,
            command,
            &decision,
            target_id,
            target_name,
            "acl-load-error: command control degraded (fail-open)",
        )
        .await;
    }

    /// Evaluate `command` against the enabled command-ACL, persist exactly one
    /// [`ShellCommandRecordingItem`] for it, and return the resulting flow.
    /// `origin` is `"exec"` (clean command line) or `"pty"` (best-effort
    /// reconstruction). Empty/no-match ruleset => [`AclFlow::Forward`], i.e. the
    /// feature is OFF by default.
    ///
    /// Role-scoped rules match here: the acting user's roles are resolved once at
    /// auth time into `acl_role_ids`. A rule-LOAD failure fails-OPEN (forward)
    /// with a WARN + one degraded-control audit record.
    async fn consult_command_acl(&self, origin: &str, command: &str) -> AclFlow {
        let (target_id, target_name) = match &self.target {
            TargetSelection::Found(target, _) => (Some(target.id), target.name.clone()),
            _ => (None, String::new()),
        };
        let rules = match self.load_command_acl_rules().await {
            Ok(rules) => rules,
            Err(err) => {
                warn!(%err, session=%self.id, "Command-ACL rule load failed; forwarding command (fail-open, command control degraded)");
                self.record_degraded_command(origin, command, target_id, &target_name)
                    .await;
                return AclFlow::Forward;
            }
        };
        let ctx = AclContext {
            protocol: "ssh",
            command,
            target_id,
            role_ids: &self.acl_role_ids,
        };
        let decision = evaluate(&rules, &ctx);
        let outcome = acl_outcome_label(decision.action);
        self.record_shell_command(origin, command, &decision, target_id, &target_name, outcome)
            .await;
        apply_acl_decision(&decision)
    }

    /// Evaluate the command-ACL for an SSH `exec` command and act on the
    /// verdict. Returns `Ok(true)` if the command may be forwarded upstream,
    /// `Ok(false)` if it was blocked (the channel is already torn down).
    ///
    /// `Allow` forwards; `Deny` blocks; `Review` PAUSES the session until an
    /// admin approves (=> forward) or rejects (=> block), with a bounded
    /// timeout that also blocks (fail-safe). Exactly one audit record is
    /// emitted per command with the resolved outcome. Empty/no-match ruleset =>
    /// forward (feature OFF by default).
    async fn authorize_exec_command(&mut self, channel_id: Uuid, command: &str) -> Result<bool> {
        let (target_id, target_name) = match &self.target {
            TargetSelection::Found(target, _) => (Some(target.id), target.name.clone()),
            _ => (None, String::new()),
        };
        let rules = match self.load_command_acl_rules().await {
            Ok(rules) => rules,
            Err(err) => {
                warn!(%err, session=%self.id, "Command-ACL rule load failed; forwarding exec command (fail-open, command control degraded)");
                self.record_degraded_command("exec", command, target_id, &target_name)
                    .await;
                return Ok(true);
            }
        };
        let ctx = AclContext {
            protocol: "ssh",
            command,
            target_id,
            role_ids: &self.acl_role_ids,
        };
        let decision = evaluate(&rules, &ctx);

        match decision.action {
            AclAction::Allow => {
                self.record_shell_command(
                    "exec",
                    command,
                    &decision,
                    target_id,
                    &target_name,
                    "allowed",
                )
                .await;
                Ok(true)
            }
            AclAction::Deny => {
                self.record_shell_command(
                    "exec",
                    command,
                    &decision,
                    target_id,
                    &target_name,
                    "blocked",
                )
                .await;
                info!(channel=%channel_id, "Exec command blocked by command-ACL");
                self.deny_command_channel(channel_id).await?;
                Ok(false)
            }
            AclAction::Review => {
                let (outcome, audit_outcome, forward) = match self
                    .await_command_review(channel_id, command, &decision, target_id, &target_name)
                    .await
                {
                    CommandReviewOutcome::Approved => {
                        ("approved by admin review", "approved", true)
                    }
                    CommandReviewOutcome::Rejected => {
                        ("rejected by admin review", "rejected", false)
                    }
                    CommandReviewOutcome::Timeout => ("review timed out", "review-timeout", false),
                };
                self.record_shell_command(
                    "exec",
                    command,
                    &decision,
                    target_id,
                    &target_name,
                    audit_outcome,
                )
                .await;
                info!(channel=%channel_id, "Exec command {outcome}");
                if !forward {
                    self.deny_command_channel(channel_id).await?;
                }
                Ok(forward)
            }
        }
    }

    /// Pause the session on an `action=review` exec command until an admin
    /// approves/rejects it or the bounded timeout elapses. Registers a pending
    /// entry in the command-review store and awaits the decision on its
    /// broadcast receiver — the same pause primitive as the web-auth flow. A
    /// closed channel (entry vacuumed/expired) or an elapsed timeout is a
    /// [`CommandReviewOutcome::Timeout`] (fail-safe block).
    async fn await_command_review(
        &mut self,
        channel_id: Uuid,
        command: &str,
        decision: &AclDecision,
        target_id: Option<Uuid>,
        target_name: &str,
    ) -> CommandReviewOutcome {
        let (user_id, username) = match &self.auth_state {
            Some(state) => {
                let info = state.lock().await.user_info().clone();
                (Some(info.id), Some(info.username))
            }
            None => (None, None),
        };
        let id = Uuid::new_v4();
        let info = CommandReviewInfo {
            id,
            session_id: Some(self.id),
            user_id,
            username,
            target_id,
            target_name: target_name.to_string(),
            origin: "exec".to_string(),
            command: command.to_string(),
            acl_rule_id: decision.rule_id,
            acl_rule_name: decision.rule_name.clone(),
            requested_at: chrono::Utc::now(),
        };
        let mut rx = self.services.command_review_store.lock().await.create(info);
        info!(channel=%channel_id, review_id=%id, "Exec command paused for admin review");
        self.notify_client_review_pending(channel_id).await;

        let outcome = match tokio::time::timeout(*COMMAND_REVIEW_TIMEOUT, rx.recv()).await {
            Ok(Ok(CommandReviewDecision::Approved)) => CommandReviewOutcome::Approved,
            Ok(Ok(CommandReviewDecision::Rejected)) => CommandReviewOutcome::Rejected,
            // Sender dropped (entry vacuumed/expired) or the timeout elapsed.
            _ => CommandReviewOutcome::Timeout,
        };
        // Drop the pending entry. `complete()` already removed it on a decision,
        // so this only matters on the timeout path (no-op otherwise).
        self.services.command_review_store.lock().await.remove(&id);
        outcome
    }

    /// Tell the client its command is paused awaiting admin review. Best-effort:
    /// a missing channel/handle is ignored. Does not close the channel.
    async fn notify_client_review_pending(&mut self, channel_id: Uuid) {
        let Ok(server_channel_id) = self.map_channel_reverse(&channel_id) else {
            return;
        };
        let sid = server_channel_id.0;
        if let Some(session) = self.session_handle.clone() {
            self.channel_writer.write(
                session,
                sid,
                Bytes::copy_from_slice(
                    b"\r\nGated: command submitted for admin review; waiting for approval...\r\n",
                ),
            );
        }
        let _ = self.channel_writer.flush().await;
    }

    /// Append one structured shell-command audit record (mirrors the SqlAudit
    /// persistence path). Best-effort: a disabled recorder or write error is
    /// logged and swallowed — auditing must never break the session.
    async fn record_shell_command(
        &self,
        origin: &str,
        command: &str,
        decision: &AclDecision,
        target_id: Option<Uuid>,
        target_name: &str,
        outcome: &str,
    ) {
        let (user_id, username) = match &self.auth_state {
            Some(state) => {
                let info = state.lock().await.user_info().clone();
                (Some(info.id), Some(info.username))
            }
            None => (None, None),
        };
        let acl_action = match decision.action {
            AclAction::Allow => "allow",
            AclAction::Deny => "deny",
            AclAction::Review => "review",
        };
        let item = ShellCommandRecordingItem::Command {
            timestamp: chrono::Utc::now(),
            target: target_name.to_string(),
            target_id,
            user_id,
            username,
            origin: origin.to_string(),
            command: command.to_string(),
            acl_action: acl_action.to_string(),
            acl_rule_id: decision.rule_id,
            acl_rule_name: decision.rule_name.clone(),
            outcome: outcome.to_string(),
        };
        let metadata = ShellCommandSessionMetadata::SshShellSession {
            target: target_name.to_string(),
            target_id,
        };
        let mut recordings = self.services.recordings.lock().await;
        match recordings
            .start::<CommandAuditRecorder, _>(
                &self.id,
                Some("shell-commands".to_string()),
                metadata,
            )
            .await
        {
            Ok(mut recorder) => {
                if let Err(err) = recorder.write_item(&item).await {
                    debug!(%err, session=%self.id, "Failed to append shell-command audit item");
                }
            }
            Err(recordings::Error::Disabled) => {}
            Err(err) => {
                debug!(%err, session=%self.id, "Shell-command recording not available");
            }
        }
    }

    /// Whether the user may open an SFTP subsystem on the selected target.
    async fn file_transfer_allowed(&self) -> bool {
        let TargetSelection::Found(target, _) = &self.target else {
            return false;
        };
        let Some(state) = &self.auth_state else {
            return false;
        };
        let username = state.lock().await.user_info().username.clone();
        let allowed = self
            .services
            .config_provider
            .lock()
            .await
            .authorize_file_transfer(&username, &target.name)
            .await
            .unwrap_or(false);
        if !allowed {
            warn!(target: "audit", session=%self.id, %username, target=%target.name, "SFTP denied: file transfer is not allowed for the user's roles on this target");
        }
        allowed
    }

    async fn finish_sftp_audit(&mut self, channel_id: &Uuid) {
        if let Some(mut auditor) = self.sftp_auditors.remove(channel_id) {
            let operations = auditor.finish();
            self.record_file_operations(operations).await;
        }
    }

    /// Append SFTP file operations to the session's file audit recording. Best-effort.
    async fn record_file_operations(&self, operations: Vec<SftpFileOperation>) {
        if operations.is_empty() {
            return;
        }
        let (target_id, target_name) = match &self.target {
            TargetSelection::Found(target, _) => (Some(target.id), target.name.clone()),
            _ => (None, String::new()),
        };
        let (user_id, username) = match &self.auth_state {
            Some(state) => {
                let info = state.lock().await.user_info().clone();
                (Some(info.id), Some(info.username))
            }
            None => (None, None),
        };
        let metadata = FileAuditSessionMetadata::SshSftpSession {
            target: target_name.clone(),
            target_id,
        };
        let mut recordings = self.services.recordings.lock().await;
        let mut recorder = match recordings
            .start::<FileAuditRecorder, _>(&self.id, Some("sftp".to_string()), metadata)
            .await
        {
            Ok(recorder) => recorder,
            Err(recordings::Error::Disabled) => return,
            Err(err) => {
                debug!(%err, session=%self.id, "File audit recording not available");
                return;
            }
        };
        for operation in operations {
            let item = FileAuditRecordingItem::Operation {
                timestamp: chrono::Utc::now(),
                target: target_name.clone(),
                target_id,
                user_id,
                username: username.clone(),
                origin: "sftp".to_string(),
                operation: operation.operation.to_string(),
                path: operation.path,
                new_path: operation.new_path,
                bytes: operation.bytes,
                success: operation.success,
                error: operation.error,
            };
            if let Err(err) = recorder.write_item(&item).await {
                debug!(%err, session=%self.id, "Failed to append file audit item");
            }
        }
    }

    /// Block a command by refusing to forward it: emit a clear message to the
    /// client, send a non-zero exit status, and close the channel. Used for an
    /// exec deny and as the best-effort terminate for a blocked interactive
    /// (PTY) command.
    async fn deny_command_channel(&mut self, channel_id: Uuid) -> Result<()> {
        let server_channel_id = self.map_channel_reverse(&channel_id)?;
        let sid = server_channel_id.0;
        if let Some(session) = self.session_handle.clone() {
            self.channel_writer.write(
                session,
                sid,
                Bytes::copy_from_slice(b"\r\nGated: command blocked by policy\r\n"),
            );
        }
        let _ = self.channel_writer.flush().await;
        // 126 == "command found but not executable" — the closest POSIX-ish
        // exit code for "refused to run".
        let _ = self
            .maybe_with_session(|handle| async move {
                handle
                    .exit_status_request(sid, 126)
                    .await
                    .context("failed to send exit status")
            })
            .await;
        let _ = self
            .maybe_with_session(|handle| async move {
                handle.close(sid).await.context("failed to close channel")
            })
            .await;
        self.remove_channel(&channel_id);
        Ok(())
    }

    /// Best-effort interactive command reconstruction + ACL for one raw PTY
    /// input chunk. Returns [`AclFlow::Block`] if a newline-terminated line
    /// matched a blocking rule; otherwise [`AclFlow::Forward`].
    ///
    /// LIMITS — this is a raw byte stream with NO line/prompt semantics. Line
    /// editing (backspace, arrow keys, ^U/^W/^C), multiline input and heredocs,
    /// bracketed pastes, and shell aliases are NOT reliably captured; terminal
    /// escape sequences may pollute the reconstructed text. We do NOT emulate a
    /// terminal, we only act at newline boundaries, and we never block
    /// mid-keystroke. Reliable filtering only exists on the exec path; PTY
    /// filtering is a safety net, not a guarantee.
    async fn filter_pty_input(&mut self, channel_id: Uuid, data: &[u8]) -> AclFlow {
        for &byte in data {
            if byte == b'\n' || byte == b'\r' {
                let line_bytes =
                    std::mem::take(self.pty_input_buffers.entry(channel_id).or_default());
                let command = String::from_utf8_lossy(&line_bytes);
                let command = command.trim();
                if command.is_empty() {
                    continue;
                }
                if self.consult_command_acl("pty", command).await == AclFlow::Block {
                    // Stop reconstructing further bytes in this chunk; the
                    // caller is about to tear the channel down.
                    return AclFlow::Block;
                }
            } else {
                self.pty_input_buffers
                    .entry(channel_id)
                    .or_default()
                    .push(byte);
            }
        }
        AclFlow::Forward
    }

    async fn _channel_exec_request(
        &mut self,
        server_channel_id: ServerChannelId,
        data: Bytes,
    ) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        match std::str::from_utf8(&data) {
            Err(e) => {
                error!(channel=%channel_id, ?data, "Requested exec - invalid UTF-8");
                anyhow::bail!(e)
            }
            Ok::<&str, _>(command) => {
                // Never log the exec command line verbatim — it can
                // carry secrets passed as arguments. Record only its length.
                debug!(channel=%channel_id, command_len = command.len(), "Requested exec");

                // Command-ACL: consult before forwarding. Allow forwards
                // unchanged; Deny blocks; Review PAUSES the session for an admin
                // decision (approve => forward, reject/timeout => block). A
                // blocked command is never sent upstream and the channel is
                // closed. Empty/no-match ruleset => forward (feature OFF by
                // default).
                if !self.authorize_exec_command(channel_id, command).await? {
                    return Ok(());
                }

                let _ = self.maybe_connect_remote().await;
                let _ = self.send_command(RCCommand::Channel(
                    channel_id,
                    ChannelOperation::RequestExec(command.to_string()),
                ));
            }
        }

        self.start_terminal_recording(
            channel_id,
            SshRecordingMetadata::Exec {
                // HACK russh ChannelId is opaque except via Display
                channel: server_channel_id.0.to_string().parse().unwrap_or_default(),
            },
        )
        .await;
        Ok(())
    }

    async fn start_terminal_recording(&mut self, channel_id: Uuid, metadata: SshRecordingMetadata) {
        let recorder = async {
            let mut recorder = self
                .services
                .recordings
                .lock()
                .await
                .start::<TerminalRecorder, _>(&self.id, None, metadata)
                .await?;
            if let Some(request) = self.channel_pty_size_map.get(&channel_id) {
                recorder
                    .write_pty_resize(request.col_width, request.row_height)
                    .await?;
            }
            Ok::<_, recordings::Error>(recorder)
        }
        .await;
        match recorder {
            Ok(recorder) => {
                self.channel_recorders.insert(channel_id, recorder);
            }
            Err(error) => match error {
                recordings::Error::Disabled => (),
                error => error!(channel=%channel_id, ?error, "Failed to start recording"),
            },
        }
    }

    async fn _channel_x11_request(
        &mut self,
        server_channel_id: ServerChannelId,
        request: X11Request,
    ) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        debug!(channel=%channel_id, "Requested X11");
        let _ = self.maybe_connect_remote().await;
        self.send_command_and_wait(RCCommand::Channel(
            channel_id,
            ChannelOperation::RequestX11(request),
        ))
        .await?;
        Ok(())
    }

    async fn _channel_env_request(
        &mut self,
        server_channel_id: ServerChannelId,
        name: String,
        value: String,
    ) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        // Log only the env var name — its value may hold a secret.
        debug!(channel=%channel_id, %name, "Environment");
        self.send_command_and_wait(RCCommand::Channel(
            channel_id,
            ChannelOperation::RequestEnv(name, value),
        ))
        .await?;
        Ok(())
    }

    async fn traffic_recorder_for(
        &mut self,
        key: TrafficRecorderKey,
        metadata: SshRecordingMetadata,
    ) -> Option<&mut TrafficRecorder> {
        if let Vacant(e) = self.traffic_recorders.entry(key.clone()) {
            match self
                .services
                .recordings
                .lock()
                .await
                .start(&self.id, None, metadata)
                .await
            {
                Ok(recorder) => {
                    e.insert(recorder);
                }
                Err(error) => {
                    error!(?key, ?error, "Failed to start recording");
                }
            }
        }
        self.traffic_recorders.get_mut(&key)
    }

    pub async fn _channel_subsystem_request(
        &mut self,
        server_channel_id: ServerChannelId,
        name: String,
    ) -> Result<(), SshClientError> {
        let channel_id = self.map_channel(&server_channel_id)?;
        info!(channel=%channel_id, "Requesting subsystem {}", &name);
        let _ = self.maybe_connect_remote().await;
        self.send_command_and_wait(RCCommand::Channel(
            channel_id,
            ChannelOperation::RequestSubsystem(name),
        ))
        .await?;
        Ok(())
    }

    async fn _data(&mut self, server_channel_id: ServerChannelId, data: Bytes) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        // Raw client->target bytes are keystrokes/passwords/tokens —
        // log only the byte length, never the content.
        debug!(channel=%server_channel_id.0, data_len = data.len(), "Data");
        if self.rc_state == RCState::Connecting && data.first() == Some(&3) {
            info!(channel=%channel_id, "User requested connection abort (Ctrl-C)");
            self.request_disconnect().await;
            return Ok(());
        }

        if let Some(recorder) = self.channel_recorders.get_mut(&channel_id)
            && let Err(error) = recorder
                .write(TerminalRecordingStreamId::Input, &data)
                .await
        {
            error!(channel=%channel_id, ?error, "Failed to record terminal data");
            self.channel_recorders.remove(&channel_id);
        }

        if let Some(recorder) = self.traffic_connection_recorders.get_mut(&channel_id)
            && let Err(error) = recorder.write_tx(&data).await
        {
            error!(channel=%channel_id, ?error, "Failed to record traffic data");
            self.traffic_connection_recorders.remove(&channel_id);
        }

        if let Some(auditor) = self.sftp_auditors.get_mut(&channel_id) {
            let operations = auditor.client_data(&data);
            self.record_file_operations(operations).await;
        }

        if self.pty_channels.contains(&channel_id) {
            let _ = self
                .event_sender
                .send_once(Event::ConsoleInput(data.clone()))
                .await;
        }

        // Don't forward the keystroke to the upstream target while a host-key
        // trust prompt is still active — the answer character would otherwise
        // leak into the user's shell once the target connection opens.
        if self.host_key_prompt_active.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Best-effort interactive command-ACL. We reconstruct commands from the
        // raw keystroke stream and only act at newline boundaries (see
        // filter_pty_input for the significant limits). Prior keystrokes of the
        // line were already streamed upstream, so we cannot un-send them; when a
        // line is blocked we instead withhold THIS chunk (including the newline,
        // so the shell never receives Enter for the buffered command) and
        // terminate the channel best-effort.
        if self.pty_channels.contains(&channel_id)
            && self.filter_pty_input(channel_id, &data).await == AclFlow::Block
        {
            info!(channel=%channel_id, "Interactive command blocked by command-ACL (best-effort)");
            return self.deny_command_channel(channel_id).await;
        }

        let _ = self.send_command(RCCommand::Channel(channel_id, ChannelOperation::Data(data)));
        Ok(())
    }

    async fn _extended_data(
        &mut self,
        server_channel_id: ServerChannelId,
        code: u32,
        data: Bytes,
    ) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        // Raw client->target bytes — log only the byte length.
        debug!(channel=%server_channel_id.0, data_len = data.len(), "Data");
        let _ = self.send_command(RCCommand::Channel(
            channel_id,
            ChannelOperation::ExtendedData { ext: code, data },
        ));
        Ok(())
    }

    async fn _tcpip_forward(&mut self, address: String, port: u32) -> Result<()> {
        info!(%address, %port, "Remote port forwarding requested");
        let _ = self.maybe_connect_remote().await;
        self.send_command_and_wait(RCCommand::ForwardTCPIP(address, port))
            .await
            .map_err(anyhow::Error::from)
    }

    pub async fn _cancel_tcpip_forward(&mut self, address: String, port: u32) -> Result<()> {
        info!(%address, %port, "Remote port forwarding cancelled");
        self.send_command_and_wait(RCCommand::CancelTCPIPForward(address, port))
            .await
            .map_err(anyhow::Error::from)
    }

    async fn _streamlocal_forward(&mut self, socket_path: String) -> Result<()> {
        info!(%socket_path, "Remote UNIX socket forwarding requested");
        let _ = self.maybe_connect_remote().await;
        self.send_command_and_wait(RCCommand::StreamlocalForward(socket_path))
            .await
            .map_err(anyhow::Error::from)
    }

    pub async fn _cancel_streamlocal_forward(&mut self, socket_path: String) -> Result<()> {
        info!(%socket_path, "Remote UNIX socket forwarding cancelled");
        self.send_command_and_wait(RCCommand::CancelStreamlocalForward(socket_path))
            .await
            .map_err(anyhow::Error::from)
    }

    async fn _agent_forward(&mut self, server_channel_id: ServerChannelId) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        debug!(channel=%channel_id, "Requested Agent Forwarding");
        self.send_command_and_wait(RCCommand::Channel(
            channel_id,
            ChannelOperation::AgentForward,
        ))
        .await?;
        Ok(())
    }

    fn note_auth_attempt(&mut self, selector: &AuthSelector, method: &'static str) {
        let (username, target) = match selector {
            AuthSelector::User {
                username,
                target_name,
            } => (sanitize_username(username), sanitize_username(target_name)),
            AuthSelector::Ticket { .. } => ("ticket".to_owned(), String::new()),
        };
        let attempts = self.auth_attempts.get_or_insert_with(|| AuthAttempts {
            username: String::new(),
            target: String::new(),
            methods: BTreeSet::new(),
        });
        attempts.username = username;
        attempts.target = target;
        attempts.methods.insert(method);
    }

    async fn _auth_publickey_offer(
        &mut self,
        ssh_username: Secret<String>,
        key: PublicKey,
    ) -> russh::server::Auth {
        let selector: AuthSelector = ssh_username.expose_secret().into();
        self.note_auth_attempt(&selector, "publickey");

        info!(
            "Client offers public key auth as {selector:?} with key {}",
            key.public_key_base64()
        );

        if !self.allowed_auth_methods.contains(&MethodKind::PublicKey) {
            warn!("Client attempted public key auth even though it was not advertised");
            return russh::server::Auth::reject();
        }

        if let Ok(true) = self
            .try_validate_public_key_offer(
                &selector,
                Some(AuthCredential::PublicKey {
                    kind: key.algorithm(),
                    public_key_bytes: Bytes::from(key.public_key_bytes()),
                }),
            )
            .await
        {
            // Only confirm the offered key (USERAUTH_PK_OK) once the
            // user is also authorized for the requested target — mirroring the
            // authorize_target gate the signed path enforces. Validating the
            // credential alone would reveal which keys are registered to clients
            // that have no access to the target (enumeration oracle).
            if let AuthSelector::User {
                username,
                target_name,
            } = &selector
            {
                let target_authorized = self
                    .services
                    .config_provider
                    .lock()
                    .await
                    .authorize_target(username, target_name)
                    .await
                    .unwrap_or(false);
                if target_authorized {
                    return russh::server::Auth::Accept;
                }
            }
        }

        let selector: AuthSelector = ssh_username.expose_secret().into();
        match self.try_auth_lazy(&selector, None).await {
            Ok(AuthResult::Need(kinds)) => russh::server::Auth::Reject {
                proceed_with_methods: Some(self.get_remaining_auth_methods(kinds)),
                partial_success: false,
            },
            _ => russh::server::Auth::reject(),
        }
    }

    async fn _auth_publickey(
        &mut self,
        ssh_username: Secret<String>,
        key: PublicKey,
    ) -> russh::server::Auth {
        let selector: AuthSelector = ssh_username.expose_secret().into();
        self.note_auth_attempt(&selector, "publickey");

        info!(
            "Public key auth as {selector:?} with key {}",
            key.public_key_base64()
        );

        if !self.allowed_auth_methods.contains(&MethodKind::PublicKey) {
            warn!("Client attempted public key auth even though it was not advertised");
            return russh::server::Auth::reject();
        }

        let key = Some(AuthCredential::PublicKey {
            kind: key.algorithm(),
            public_key_bytes: Bytes::from(key.public_key_bytes()),
        });

        let result = self.try_auth_lazy(&selector, key.clone()).await;

        match result {
            Ok(AuthResult::Accepted { .. }) => {
                // Update last_used timestamp
                if let Err(err) = self
                    .services
                    .config_provider
                    .lock()
                    .await
                    .update_public_key_last_used(key.clone())
                    .await
                {
                    warn!(?err, "Failed to update last_used for public key");
                }
                russh::server::Auth::Accept
            }
            Ok(AuthResult::Rejected) => russh::server::Auth::Reject {
                proceed_with_methods: Some(MethodSet::server_supported()),
                partial_success: false,
            },
            Ok(AuthResult::Need(kinds)) => russh::server::Auth::Reject {
                proceed_with_methods: Some(self.get_remaining_auth_methods(kinds)),
                partial_success: false,
            },
            Err(error) => {
                error!(?error, "Failed to verify credentials");
                russh::server::Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                }
            }
        }
    }

    async fn _auth_password(
        &mut self,
        ssh_username: Secret<String>,
        password: Secret<String>,
    ) -> russh::server::Auth {
        let selector: AuthSelector = ssh_username.expose_secret().into();
        self.note_auth_attempt(&selector, "password");
        info!("Password auth as {selector:?}");

        if !self.allowed_auth_methods.contains(&MethodKind::Password) {
            warn!("Client attempted password auth even though it was not advertised");
            return russh::server::Auth::reject();
        }

        match self
            .try_auth_lazy(&selector, Some(AuthCredential::Password(password)))
            .await
        {
            Ok(AuthResult::Accepted { .. }) => russh::server::Auth::Accept,
            Ok(AuthResult::Rejected) => russh::server::Auth::reject(),
            Ok(AuthResult::Need(kinds)) => russh::server::Auth::Reject {
                proceed_with_methods: Some(self.get_remaining_auth_methods(kinds)),
                partial_success: false,
            },
            Err(error) => {
                error!(?error, "Failed to verify credentials");
                russh::server::Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                }
            }
        }
    }

    async fn _auth_keyboard_interactive(
        &mut self,
        ssh_username: Secret<String>,
        response: Option<Secret<String>>,
    ) -> russh::server::Auth {
        let selector: AuthSelector = ssh_username.expose_secret().into();
        self.note_auth_attempt(&selector, "keyboard-interactive");
        info!("Keyboard-interactive auth as {:?}", selector);

        if !self
            .allowed_auth_methods
            .contains(&MethodKind::KeyboardInteractive)
        {
            warn!("Client attempted keyboard-interactive auth even though it was not advertised");
            return russh::server::Auth::reject();
        }

        let cred;
        match &mut self.keyboard_interactive_state {
            KeyboardInteractiveState::None => {
                cred = None;
            }
            KeyboardInteractiveState::OtpRequested => {
                cred = response.map(AuthCredential::Otp);
            }
            KeyboardInteractiveState::WebAuthRequested(event) => {
                cred = None;
                let _ = event.recv().await;
                // the auth state has been updated by now
            }
        }

        self.keyboard_interactive_state = KeyboardInteractiveState::None;

        match self.try_auth_lazy(&selector, cred).await {
            Ok(AuthResult::Accepted { .. }) => russh::server::Auth::Accept,
            Ok(AuthResult::Rejected) => russh::server::Auth::reject(),
            Ok(AuthResult::Need(kinds)) => {
                if kinds.contains(&CredentialKind::Totp) {
                    self.keyboard_interactive_state = KeyboardInteractiveState::OtpRequested;
                    russh::server::Auth::Partial {
                        name: Cow::Borrowed("Two-factor authentication"),
                        instructions: Cow::Borrowed(""),
                        prompts: Cow::Owned(vec![(Cow::Borrowed("One-time password: "), true)]),
                    }
                } else if kinds.contains(&CredentialKind::WebUserApproval) {
                    let Some(auth_state) = self.auth_state.as_ref() else {
                        return russh::server::Auth::Reject {
                            proceed_with_methods: None,
                            partial_success: false,
                        };
                    };
                    let identification_string =
                        auth_state.lock().await.identification_string().to_owned();
                    let auth_state_id = *auth_state.lock().await.id();
                    let event = self
                        .services
                        .auth_state_store
                        .lock()
                        .await
                        .subscribe(auth_state_id);
                    self.keyboard_interactive_state =
                        KeyboardInteractiveState::WebAuthRequested(event);

                    let login_url = match auth_state
                        .lock()
                        .await
                        .construct_web_approval_url(&*self.services.config.read().await)
                    {
                        Ok(login_url) => login_url,
                        Err(error) => {
                            error!(?error, "Failed to construct external URL");
                            return russh::server::Auth::Reject {
                                proceed_with_methods: None,
                                partial_success: false,
                            };
                        }
                    };

                    russh::server::Auth::Partial {
                        name: Cow::Borrowed("Gated authentication"),
                        instructions: Cow::Owned(format!(
                            concat!(
                                "-----------------------------------------------------------------------\n",
                                "Gated authentication: please open the following URL in your browser:\n",
                                "{}\n\n",
                                "Make sure you're seeing this security key: {}\n",
                                "-----------------------------------------------------------------------\n"
                            ),
                            login_url,
                            identification_string
                                .chars()
                                .map(|x| x.to_string())
                                .collect::<Vec<_>>()
                                .join(" ")
                        )),
                        prompts: Cow::Owned(vec![(Cow::Borrowed("Press Enter when done: "), true)]),
                    }
                } else {
                    russh::server::Auth::Reject {
                        proceed_with_methods: None,
                        partial_success: false,
                    }
                }
            }
            Err(error) => {
                error!(?error, "Failed to verify credentials");
                russh::server::Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                }
            }
        }
    }

    fn get_remaining_auth_methods(&self, kinds: HashSet<CredentialKind>) -> MethodSet {
        let mut m = MethodSet::empty();

        for cred_kind in kinds {
            let method_kind = match cred_kind {
                CredentialKind::Password => MethodKind::Password,
                CredentialKind::Totp => MethodKind::KeyboardInteractive,
                CredentialKind::WebUserApproval => MethodKind::KeyboardInteractive,
                CredentialKind::PublicKey => MethodKind::PublicKey,
                CredentialKind::Sso => MethodKind::KeyboardInteractive,
                CredentialKind::Certificate => {
                    // Certificate authentication is not supported for SSH protocol
                    // This credential type is primarily for Kubernetes
                    continue;
                }
            };
            if self.allowed_auth_methods.contains(&method_kind) {
                m.push(method_kind);
            }
        }

        if m.contains(&MethodKind::KeyboardInteractive) {
            // Ensure keyboard-interactive is always the last method
            m.push(MethodKind::KeyboardInteractive);
        }

        m
    }

    async fn try_validate_public_key_offer(
        &mut self,
        selector: &AuthSelector,
        credential: Option<AuthCredential>,
    ) -> Result<bool> {
        match selector {
            AuthSelector::User { username, .. } => {
                let cp = self.services.config_provider.clone();

                if let Some(credential) = credential {
                    return Ok(cp
                        .lock()
                        .await
                        .validate_credential(username, &credential)
                        .await?);
                }

                Ok(false)
            }
            _ => Ok(false),
        }
    }

    /// As try_auth_lazy is called multiple times, this memoization prevents
    /// consuming the ticket multiple times, depleting its uses.
    async fn try_auth_lazy(
        &mut self,
        selector: &AuthSelector,
        credential: Option<AuthCredential>,
    ) -> Result<AuthResult> {
        if let AuthSelector::Ticket { secret } = selector {
            if let Some(ref csta) = self.cached_successful_ticket_auth {
                // Only if the client hasn't maliciously changed the username
                // between auth attempts
                if &csta.ticket == secret {
                    return Ok(AuthResult::Accepted {
                        user_info: csta.user_info.clone(),
                    });
                }
            }

            let result = self.try_auth_eager(selector, credential).await?;
            if let AuthResult::Accepted { ref user_info } = result {
                self.cached_successful_ticket_auth = Some(CachedSuccessfulTicketAuth {
                    ticket: secret.clone(),
                    user_info: user_info.clone(),
                });
            }

            return Ok(result);
        }
        self.try_auth_eager(selector, credential).await
    }

    async fn try_auth_eager(
        &mut self,
        selector: &AuthSelector,
        credential: Option<AuthCredential>,
    ) -> Result<AuthResult> {
        match selector {
            AuthSelector::User {
                username,
                target_name,
            } => {
                let cp = self.services.config_provider.clone();

                let state_arc = self.get_auth_state(username).await?;
                let mut state = state_arc.lock().await;

                if let Some(credential) = credential
                    && cp
                        .lock()
                        .await
                        .validate_credential(username, &credential)
                        .await?
                {
                    state.add_valid_credential(credential);
                }

                let user_auth_result = state.verify();

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
                                .authorize_target(&user_info.username, target_name)
                                .await?
                        };
                        if !target_auth_result {
                            warn!(target: "audit",
                                "Target {} not authorized for user {}",
                                target_name, username
                            );
                            return Ok(AuthResult::Rejected);
                        }
                        self._auth_accept(user_info.clone(), target_name).await?;
                        Ok(AuthResult::Accepted { user_info })
                    }
                    x => Ok(x),
                }
            }
            AuthSelector::Ticket { secret } => {
                match authorize_ticket(&self.services.db, secret).await? {
                    Some((ticket, user_info)) => {
                        info!("Authorized for {} with a ticket", ticket.target);
                        consume_ticket(&self.services.db, &ticket.id).await?;
                        self._auth_accept(user_info.clone(), &ticket.target).await?;

                        Ok(AuthResult::Accepted { user_info })
                    }
                    None => Ok(AuthResult::Rejected),
                }
            }
        }
    }

    async fn _auth_accept(
        &mut self,
        user_info: AuthStateUserInfo,
        target_name: &str,
    ) -> Result<(), GatedError> {
        self.username = Some(user_info.username.clone());
        let _ = self
            .server_handle
            .lock()
            .await
            .set_user_info(user_info.clone())
            .await;

        // Resolve the acting user's role UUIDs once so role-scoped command-ACL
        // rules match on SSH (parity with the DB proxies, which resolve roles at
        // session auth via the same loader). Best-effort: on a DB/query failure
        // we keep an empty set — global/protocol/target rules still apply.
        self.acl_role_ids = match gated_core::db_required(&self.services.db).await {
            Ok(db) => gated_core::command_acl_loader::load_user_role_ids(&db, user_info.id)
                .await
                .unwrap_or_else(|err| {
                    warn!(%err, "Failed to load user role ids for command-ACL; role-scoped rules will not match");
                    Vec::new()
                }),
            Err(err) => {
                warn!(%err, "DB unavailable resolving user role ids for command-ACL");
                Vec::new()
            }
        };

        let target = {
            self.services
                .config_provider
                .lock()
                .await
                .list_targets()
                .await?
                .iter()
                .filter_map(|t| match t.options {
                    TargetOptions::Ssh(ref options) => Some((t, options)),
                    _ => None,
                })
                .find(|(t, _)| t.name == target_name)
                .map(|(t, opt)| (t.clone(), opt.clone()))
        };

        let Some((target, _ssh_options)) = target else {
            self.target = TargetSelection::NotFound(target_name.to_string());
            warn!("Selected target not found");
            return Ok(());
        };

        let (ssh_options, account_id) = {
            let db = gated_core::db_required(&self.services.db)
                .await
                .map_err(|e| GatedError::Other(anyhow::anyhow!(e).into()))?;
            gated_core::account_credentials::ssh_options_with_account(
                &db,
                &target,
                Some(&user_info.username),
            )
            .await
            .map_err(|e| GatedError::Other(anyhow::anyhow!(e).into()))?
        };

        if let Some(account_id) = account_id {
            let db = gated_core::db_required(&self.services.db)
                .await
                .map_err(|e| GatedError::Other(anyhow::anyhow!(e).into()))?;
            gated_core::account_credentials::update_account_last_used_at(&db, account_id)
                .await
                .map_err(|e| GatedError::Other(anyhow::anyhow!(e).into()))?;
        }

        let _ = self.server_handle.lock().await.set_target(&target).await;
        self.target = TargetSelection::Found(target, ssh_options);
        Ok(())
    }

    async fn _channel_close(&mut self, server_channel_id: ServerChannelId) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        debug!(channel=%channel_id, "Closing channel");
        self.send_command_and_wait(RCCommand::Channel(channel_id, ChannelOperation::Close))
            .await?;
        self.finish_sftp_audit(&channel_id).await;
        self.remove_channel(&channel_id);
        Ok(())
    }

    async fn _channel_eof(&mut self, server_channel_id: ServerChannelId) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        debug!(channel=%channel_id, "EOF");
        let _ = self.send_command(RCCommand::Channel(channel_id, ChannelOperation::Eof));
        Ok(())
    }

    pub async fn _channel_signal(
        &mut self,
        server_channel_id: ServerChannelId,
        signal: Sig,
    ) -> Result<()> {
        let channel_id = self.map_channel(&server_channel_id)?;
        debug!(channel=%channel_id, ?signal, "Signal");
        self.send_command_and_wait(RCCommand::Channel(
            channel_id,
            ChannelOperation::Signal(signal),
        ))
        .await?;
        Ok(())
    }

    fn send_command(&mut self, command: RCCommand) -> Result<(), RCCommand> {
        self.rc_tx.send((command, None)).map_err(|e| e.0.0)
    }

    async fn send_command_and_wait(&mut self, command: RCCommand) -> Result<(), SshClientError> {
        let (tx, rx) = oneshot::channel();
        let mut cmd = match self.rc_tx.send((command, Some(tx))) {
            Ok(_) => PendingCommand::Waiting(rx),
            Err(_) => PendingCommand::Failed,
        };

        loop {
            tokio::select! {
                result = &mut cmd => {
                    return result
                }
                event = self.get_next_event() => {
                    match event {
                        Some(event) => {
                            self.handle_event(event).await.map_err(SshClientError::from)?
                        }
                        None => {Err(SshClientError::MpscError)?}
                    };
                }
            }
        }
    }

    async fn request_disconnect(&mut self) {
        debug!("Disconnecting");
        let _ = self.rc_abort_tx.send(());
        if self.rc_state != RCState::NotInitialized && self.rc_state != RCState::Disconnected {
            let _ = self.send_command(RCCommand::Disconnect);
        }
    }

    /// Free all per-session bookkeeping for a channel once it has closed.
    ///
    /// Without this, the channel collections only ever grow and are cleared
    /// solely on full session teardown, letting a client exhaust memory by
    /// repeatedly opening and closing channels. Idempotent: a
    /// channel close can be observed from both the client (`RCEvent::Close`)
    /// and the server (`_channel_close`) side.
    fn remove_channel(&mut self, channel_id: &Uuid) {
        self.channel_map.remove_by_right(channel_id);
        self.all_channels.retain(|c| c != channel_id);
        self.pty_channels.retain(|c| c != channel_id);
        self.channel_pty_size_map.remove(channel_id);
        self.channel_recorders.remove(channel_id);
        self.traffic_connection_recorders.remove(channel_id);
        self.pty_input_buffers.remove(channel_id);
    }

    async fn disconnect_server(&mut self) {
        let all_channels = std::mem::take(&mut self.all_channels);
        let channels = all_channels
            .into_iter()
            .map(|x| self.map_channel_reverse(&x))
            .filter_map(|x| x.ok())
            .collect::<Vec<_>>();

        let _ = self
            .maybe_with_session(|handle| async move {
                for ch in channels {
                    let _ = handle.close(ch.0).await;
                }
                Ok(())
            })
            .await;

        self.session_handle = None;
    }
}

impl Drop for ServerSession {
    fn drop(&mut self) {
        if self.username.is_none()
            && let Some(attempts) = &self.auth_attempts
        {
            let methods = attempts
                .methods
                .iter()
                .copied()
                .collect::<Vec<_>>()
                .join(",");
            warn!(target: "audit",
                session = %self.id,
                username = %attempts.username,
                target = %attempts.target,
                protocol = "ssh",
                methods = %methods,
                client_ip = %self.remote_address.ip(),
                "auth_login_rejected"
            );
        }
        let _ = self.rc_abort_tx.send(());
        info!("Closed session");
        debug!("Dropped");
    }
}

pub enum PendingCommand {
    Waiting(oneshot::Receiver<Result<(), SshClientError>>),
    Failed,
}

impl Future for PendingCommand {
    type Output = Result<(), SshClientError>;

    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
        match self.get_mut() {
            PendingCommand::Waiting(rx) => match Pin::new(rx).poll(cx) {
                Poll::Ready(result) => {
                    Poll::Ready(result.unwrap_or(Err(SshClientError::MpscError)))
                }
                Poll::Pending => Poll::Pending,
            },
            PendingCommand::Failed => Poll::Ready(Err(SshClientError::MpscError)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_username;

    #[test]
    fn sanitize_username_strips_crlf_and_escapes() {
        // CR/LF used to forge a second log line, plus an ANSI escape sequence.
        let malicious = "alice\r\nFAKE LOG injected\x1b[31m payload";
        let sanitized = sanitize_username(malicious);
        assert!(!sanitized.contains('\r'));
        assert!(!sanitized.contains('\n'));
        assert!(!sanitized.contains('\x1b'));
        assert!(!sanitized.chars().any(|c| c.is_control()));
        // Printable content is preserved.
        assert!(sanitized.starts_with("alice"));
    }

    #[test]
    fn sanitize_username_leaves_plain_value_untouched() {
        assert_eq!(sanitize_username("alice:target"), "alice:target");
    }
}
