//! Browser desktop sessions: `GET /api/desktop/{target}` upgrades to a
//! WebSocket that carries an RDP or VNC session. The gateway is the protocol
//! client; the browser gets pixels and sends input, and never sees the
//! target's credentials.

mod jpeg;
mod protocol;
mod tiles;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use gated_common::auth::AuthStateUserInfo;
use gated_common::web::Data;
use gated_common::{Secret, Target, TargetOptions};
use gated_core::account_credentials::DesktopLogin;
use gated_core::recordings::DesktopRecorder;
use gated_core::{
    ConfigProvider, DesktopClientHandles, DesktopEvent, DesktopInput, DesktopRect, DesktopState,
    Framebuffer, Rect, Services, SessionStateInit, State, truncate_clipboard_contents_in_place,
};
use http::StatusCode;
use serde::Deserialize;
use tokio::sync::Notify;
use tokio::sync::mpsc::{Receiver, Sender};
use tracing::*;
use uuid::Uuid;

use self::protocol::{
    ClientMessage, ConnectedDetails, IMAGE_CURSOR, IMAGE_JPEG, IMAGE_RAW, ServerMessage,
    SessionState, image_frame,
};
use self::tiles::DirtyTiles;
use super::super::common::{RequestAuthorization, SessionAuthorization, upgrade};
use super::common::{TERMINAL_CLOSED_MESSAGE, TerminalSessionHandle};
use super::ssh_terminal::{ResolveError, cleanup_empty_session, select_login};

/// Each session holds two copies of the remote screen (one to send from, one
/// in the recorder), so they are rationed more tightly than terminals.
const MAX_SESSIONS_PER_USER: usize = 4;
const MAX_SESSIONS: usize = 32;

const MAX_TARGET_NAME_LEN: usize = 128;

/// Clipboard text is cut to this size in both directions.
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

/// Largest message accepted from the viewer: a full clipboard, JSON-escaped.
const MAX_VIEWER_MESSAGE_BYTES: usize = 4 * MAX_CLIPBOARD_BYTES;

/// Notices waiting for the viewer beyond this are dropped.
const MAX_QUEUED_NOTICES: usize = 16;

const WS_PING_INTERVAL: Duration = Duration::from_secs(30);

/// How often a ticket and the clipboard permission are checked again.
const RECHECK_INTERVAL: Duration = Duration::from_secs(10);

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Default)]
struct SessionCounts {
    total: usize,
    by_user: HashMap<String, usize>,
}

static SESSION_COUNTS: LazyLock<Mutex<SessionCounts>> = LazyLock::new(Mutex::default);

/// One reserved desktop session; released on drop, on every exit path.
struct SessionSlot {
    username: String,
}

impl SessionSlot {
    fn acquire(username: &str) -> Option<Self> {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut counts = SESSION_COUNTS.lock().unwrap();
        if counts.total >= MAX_SESSIONS {
            return None;
        }
        let count = counts.by_user.entry(username.to_owned()).or_insert(0);
        if *count >= MAX_SESSIONS_PER_USER {
            return None;
        }
        *count += 1;
        counts.total += 1;
        Some(Self {
            username: username.to_owned(),
        })
    }
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut counts = SESSION_COUNTS.lock().unwrap();
        counts.total = counts.total.saturating_sub(1);
        if let Some(count) = counts.by_user.get_mut(&self.username) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.by_user.remove(&self.username);
            }
        }
    }
}

fn validate_target_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_TARGET_NAME_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// What a notice replaces in the queue: only the latest of its kind matters.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    Resize,
    Clipboard,
    Bell,
    Cursor,
    /// Kept in order, up to `MAX_QUEUED_NOTICES`.
    Notice,
}

/// What `Screen::take` hands to the sender.
struct Pending {
    messages: Vec<Message>,
    /// Changed regions as RGBA.
    regions: Vec<(Rect, Vec<u8>)>,
    ended: bool,
}

/// What the backend produced and the viewer has not been sent yet.
#[derive(Default)]
struct Screen {
    framebuffer: Framebuffer,
    dirty: DirtyTiles,
    queue: VecDeque<(Slot, Message)>,
    ended: bool,
}

impl Screen {
    fn push(&mut self, slot: Slot, message: Message) {
        if slot == Slot::Notice {
            let notices = self.queue.iter().filter(|(s, _)| *s == slot).count();
            if notices >= MAX_QUEUED_NOTICES {
                return;
            }
        } else {
            self.queue.retain(|(s, _)| *s != slot);
        }
        self.queue.push_back((slot, message));
    }

    fn push_json(&mut self, slot: Slot, message: &ServerMessage) {
        self.push(slot, Message::Text(message.json().into()));
    }

    fn mark(&mut self, rect: DesktopRect) {
        self.dirty.mark(
            u32::from(rect.x),
            u32::from(rect.y),
            u32::from(rect.width),
            u32::from(rect.height),
        );
    }

    /// Take in one backend event. Pixels go to the framebuffer; the rest is
    /// queued for the viewer.
    fn apply(&mut self, event: DesktopEvent, allow_clipboard: bool) {
        match event {
            DesktopEvent::Resize { width, height } => {
                self.framebuffer.apply(&event);
                self.dirty.resize(u32::from(width), u32::from(height));
                self.push_json(Slot::Resize, &ServerMessage::Resize { width, height });
            }
            DesktopEvent::RawImage { rect, .. }
            | DesktopEvent::JpegImage { rect, .. }
            | DesktopEvent::PngImage { rect, .. } => {
                self.framebuffer.apply(&event);
                self.mark(rect);
            }
            DesktopEvent::CopyRect { dst, .. } => {
                self.framebuffer.apply(&event);
                self.mark(dst);
            }
            DesktopEvent::Cursor { rect, data } => {
                let frame = image_frame(
                    IMAGE_CURSOR,
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    &bgra_to_rgba(&data),
                );
                self.push(Slot::Cursor, Message::Binary(frame.into()));
            }
            DesktopEvent::CursorDefault => {
                self.push_json(Slot::Cursor, &ServerMessage::CursorDefault);
            }
            DesktopEvent::CursorHidden => {
                self.push_json(Slot::Cursor, &ServerMessage::CursorHidden);
            }
            DesktopEvent::Clipboard(mut text) => {
                if allow_clipboard {
                    truncate_clipboard_contents_in_place(&mut text, MAX_CLIPBOARD_BYTES);
                    self.push_json(Slot::Clipboard, &ServerMessage::Clipboard { text });
                }
            }
            DesktopEvent::Bell => self.push_json(Slot::Bell, &ServerMessage::Bell),
            DesktopEvent::Error(message) => {
                self.push_json(Slot::Notice, &ServerMessage::Error { message });
            }
            DesktopEvent::State(_) => {}
        }
    }

    /// Everything to send now: queued messages, then the changed regions as
    /// RGBA.
    fn take(&mut self) -> Pending {
        let messages = self.queue.drain(..).map(|(_, message)| message).collect();
        let mut regions = Vec::new();
        for rect in self.dirty.take() {
            let mut rgba = Vec::new();
            if let Some(rect) = self.framebuffer.copy_region_rgba(rect, &mut rgba) {
                regions.push((rect, rgba));
            }
        }
        Pending {
            messages,
            regions,
            ended: self.ended,
        }
    }
}

fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len());
    for pixel in bgra.as_chunks::<4>().0 {
        let [b, g, r, a] = *pixel;
        out.extend_from_slice(&[r, g, b, a]);
    }
    out
}

#[allow(clippy::unwrap_used, reason = "panic on poison")]
fn lock(screen: &Mutex<Screen>) -> std::sync::MutexGuard<'_, Screen> {
    screen.lock().unwrap()
}

/// A changed region as a binary frame: JPEG, or raw when it is small.
async fn region_frame(rect: Rect, rgba: Vec<u8>) -> Option<Message> {
    let header = |kind, data: &[u8]| {
        Some(image_frame(
            kind,
            u16::try_from(rect.x).ok()?,
            u16::try_from(rect.y).ok()?,
            u16::try_from(rect.width).ok()?,
            u16::try_from(rect.height).ok()?,
            data,
        ))
    };
    let frame = if rgba.len() < jpeg::MIN_ENCODE_BYTES {
        header(IMAGE_RAW, &rgba)?
    } else {
        // CPU-bound: keep it off the async workers.
        let (jpeg, rgba) = tokio::task::spawn_blocking(move || {
            (jpeg::encode_rgba(rect.width, rect.height, &rgba), rgba)
        })
        .await
        .ok()?;
        match jpeg {
            Some(jpeg) => header(IMAGE_JPEG, &jpeg)?,
            None => header(IMAGE_RAW, &rgba)?,
        }
    };
    Some(Message::Binary(frame.into()))
}

/// Backend events into the shared screen and the recording.
async fn pump_events(
    mut event_rx: Receiver<DesktopEvent>,
    screen: Arc<Mutex<Screen>>,
    wake: Arc<Notify>,
    recorder: Option<Arc<DesktopRecorder>>,
    allow_clipboard: Arc<AtomicBool>,
    connected: ServerMessage,
) {
    while let Some(event) = event_rx.recv().await {
        match event {
            DesktopEvent::State(DesktopState::Disconnected) => break,
            DesktopEvent::State(DesktopState::Connected) => {
                lock(&screen).push_json(Slot::Notice, &connected);
            }
            event => {
                if let Some(recorder) = &recorder
                    && let Err(error) = recorder.write_event(&event).await
                {
                    debug!(%error, "Failed to record a desktop event");
                }
                lock(&screen).apply(event, allow_clipboard.load(Ordering::Relaxed));
            }
        }
        wake.notify_one();
    }
    lock(&screen).ended = true;
    wake.notify_one();
}

/// The shared screen to the viewer, as fast as its socket takes it.
async fn send_screen(
    mut sink: SplitSink<WebSocket, Message>,
    screen: Arc<Mutex<Screen>>,
    wake: Arc<Notify>,
    close: Arc<Notify>,
) {
    let mut ping = tokio::time::interval(WS_PING_INTERVAL);
    ping.tick().await;

    let reason = 'session: loop {
        let Pending {
            messages,
            regions,
            ended,
        } = lock(&screen).take();
        for message in messages {
            if sink.send(message).await.is_err() {
                return;
            }
        }
        for (rect, rgba) in regions {
            if let Some(frame) = region_frame(rect, rgba).await
                && sink.send(frame).await.is_err()
            {
                return;
            }
        }
        if ended {
            break "The target closed the session";
        }
        loop {
            tokio::select! {
                () = wake.notified() => break,
                () = close.notified() => break 'session TERMINAL_CLOSED_MESSAGE,
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        return;
                    }
                }
            }
        }
    };
    let closed = ServerMessage::state(SessionState::Closed, reason);
    let _ = sink.send(Message::Text(closed.json().into())).await;
    let _ = sink.close().await;
}

/// Viewer input to the backend and the recording. Returns when the viewer
/// leaves or the backend is gone.
async fn forward_input(
    mut source: SplitStream<WebSocket>,
    input_tx: Sender<DesktopInput>,
    recorder: Option<Arc<DesktopRecorder>>,
    allow_clipboard: Arc<AtomicBool>,
    record_clipboard: bool,
) {
    while let Some(Ok(message)) = source.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else {
            continue;
        };
        let mut input = DesktopInput::from(message);
        let mut record = true;
        if let DesktopInput::Clipboard(text) = &mut input {
            if !allow_clipboard.load(Ordering::Relaxed) {
                continue;
            }
            truncate_clipboard_contents_in_place(text, MAX_CLIPBOARD_BYTES);
            // Pasted text is treated like typed text.
            record = record_clipboard;
        }
        if record
            && let Some(recorder) = &recorder
            && let Err(error) = recorder.write_input(&input).await
        {
            debug!(%error, "Failed to record a desktop input");
        }
        if input_tx.send(input).await.is_err() {
            break;
        }
    }
}

struct Resolved {
    target: Target,
    user_info: AuthStateUserInfo,
    login: DesktopLogin,
    allow_clipboard: bool,
}

/// Authorize the user for the target and work out the login to present.
async fn resolve_and_authorize(
    services: &Services,
    username: &str,
    target_name: &str,
    account: Option<&str>,
) -> Result<Resolved, ResolveError> {
    use ResolveError::Denied;
    let internal = |error: &dyn std::fmt::Display, what: &str| {
        error!(%error, "{what}");
        Denied("Internal server error")
    };

    let (target, user_info, allow_clipboard) = {
        let mut config_provider = services.config_provider.lock().await;
        let user = config_provider
            .get_user(username)
            .await
            .map_err(|e| internal(&e, "Failed to load user"))?
            .ok_or(Denied("User not found"))?;
        if !config_provider
            .authorize_target(username, target_name)
            .await
            .map_err(|e| internal(&e, "Authorization check failed"))?
        {
            return Err(Denied("Access denied to target"));
        }
        let target = config_provider
            .get_target(target_name)
            .await
            .map_err(|e| internal(&e, "Failed to load target"))?
            .ok_or(Denied("Target not found"))?;
        if !matches!(
            target.options,
            TargetOptions::Rdp(_) | TargetOptions::Vnc(_)
        ) {
            return Err(Denied("Target is not a desktop target"));
        }
        let allow_clipboard = config_provider
            .authorize_clipboard(username, target_name)
            .await
            .map_err(|e| internal(&e, "Clipboard check failed"))?;
        let user_info = AuthStateUserInfo {
            id: user.id,
            username: username.to_owned(),
        };
        (target, user_info, allow_clipboard)
    };

    let db = gated_core::db_required(&services.db)
        .await
        .map_err(|e| internal(&e, "Database unavailable"))?;
    let selected = select_login(&db, &target, username, account).await?;
    let login = gated_core::account_credentials::desktop_login(&db, &target, selected)
        .await
        .map_err(|e| internal(&e, "Failed to resolve the desktop account"))?;
    if let Some(account_id) = login.account_id {
        let _ = gated_core::account_credentials::update_account_last_used_at(&db, account_id).await;
    }

    Ok(Resolved {
        target,
        user_info,
        login,
        allow_clipboard,
    })
}

/// Start the protocol client for the target. `None`: no client for its kind.
/// What the viewer asks for when it opens the socket.
#[derive(Deserialize)]
pub struct DesktopQuery {
    /// The account to sign in with, when the target has several.
    account: Option<String>,
    /// The viewer's window, in pixels. An RDP target is asked for a desktop
    /// of this size; a VNC target has its own.
    width: Option<u16>,
    height: Option<u16>,
}

fn connect_backend(
    options: &TargetOptions,
    login: DesktopLogin,
    allow_clipboard: bool,
    size: Option<(u16, u16)>,
) -> Option<DesktopClientHandles> {
    match options {
        TargetOptions::Rdp(options) => Some(gated_protocol_rdp::connect(
            gated_protocol_rdp::RdpClientOptions {
                host: options.host.clone(),
                port: options.port,
                username: login.username,
                domain: login.domain,
                password: Secret::new(login.password.unwrap_or_default()),
                verify_tls: options.verify_tls,
                allow_clipboard,
                size,
            },
        )),
        TargetOptions::Vnc(options) => Some(gated_protocol_vnc::connect(
            gated_protocol_vnc::VncClientOptions {
                host: options.host.clone(),
                port: options.port,
                password: login.password.map(Secret::new),
                allow_clipboard,
            },
        )),
        _ => None,
    }
}

async fn send_state(sink: &mut SplitSink<WebSocket, Message>, state: SessionState, message: &str) {
    let message = ServerMessage::state(state, message);
    let _ = sink.send(Message::Text(message.json().into())).await;
}

pub async fn api_desktop(
    ws: WebSocketUpgrade,
    Path(target_name): Path<String>,
    Query(query): Query<DesktopQuery>,
    services: Data<Services>,
    auth: Option<Data<RequestAuthorization>>,
) -> Response {
    let services = services.0;

    if !validate_target_name(&target_name) {
        return (StatusCode::BAD_REQUEST, "Invalid target name").into_response();
    }
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
    let username = match auth.map(|auth| auth.0.clone()) {
        Some(RequestAuthorization::Session(SessionAuthorization::User(username)))
        | Some(RequestAuthorization::Session(SessionAuthorization::Ticket { username, .. }))
        | Some(RequestAuthorization::UserToken { username }) => username,
        _ => {
            warn!(target = %target_name, protocol = "desktop", "desktop_unauthenticated");
            return (StatusCode::UNAUTHORIZED, "Not authenticated").into_response();
        }
    };

    // Moves into the upgrade callback; released when that ends or never runs.
    let Some(slot) = SessionSlot::acquire(&username) else {
        warn!(
            username = %username,
            target = %target_name,
            protocol = "desktop",
            "desktop_session_limit"
        );
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Too many concurrent desktop sessions",
        )
            .into_response();
    };

    let ws = ws.max_message_size(MAX_VIEWER_MESSAGE_BYTES);
    upgrade(ws, move |socket| async move {
        let _slot = slot;
        let (mut sink, source) = socket.split();

        let resolved = match resolve_and_authorize(
            &services,
            &username,
            &target_name,
            query.account.as_deref(),
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(reason) => {
                warn!(
                    username = %username,
                    target = %target_name,
                    protocol = "desktop",
                    reason = %reason,
                    "desktop_authorize_failed"
                );
                send_state(&mut sink, SessionState::Closed, &reason.to_string()).await;
                return;
            }
        };
        let Resolved {
            target,
            user_info,
            login,
            allow_clipboard,
        } = resolved;

        let (protocol_name, address, record_keystrokes) = match &target.options {
            TargetOptions::Rdp(options) => (
                "WebRDP",
                format!("{}:{}", options.host, options.port),
                options.record_keystrokes,
            ),
            TargetOptions::Vnc(options) => (
                "WebVNC",
                format!("{}:{}", options.host, options.port),
                options.record_keystrokes,
            ),
            _ => return,
        };

        let close = Arc::new(Notify::new());
        let allow_clipboard = Arc::new(AtomicBool::new(allow_clipboard));
        // A ticket that is deleted or expires ends the session; a role that
        // loses the clipboard loses it in the running session too.
        let _recheck = {
            let (services, close, allow_clipboard) =
                (services.clone(), close.clone(), allow_clipboard.clone());
            let (username, target_name) = (username.clone(), target.name.clone());
            AbortOnDrop(tokio::spawn(async move {
                let mut interval = tokio::time::interval(RECHECK_INTERVAL);
                interval.tick().await;
                loop {
                    interval.tick().await;
                    if let Some(ticket_id) = ticket_id
                        && let Ok(false) =
                            gated_core::ticket_is_live(&services.db, &ticket_id).await
                    {
                        close.notify_one();
                        return;
                    }
                    if allow_clipboard.load(Ordering::Relaxed) {
                        let allowed = services
                            .config_provider
                            .lock()
                            .await
                            .authorize_clipboard(&username, &target_name)
                            .await;
                        if !matches!(allowed, Ok(true)) {
                            allow_clipboard.store(false, Ordering::Relaxed);
                        }
                    }
                }
            }))
        };

        let session_handle = match State::register_session(
            &services.state,
            &protocol_name,
            SessionStateInit {
                remote_address: None,
                handle: Box::new(TerminalSessionHandle(close.clone())),
            },
        )
        .await
        {
            Ok(handle) => handle,
            Err(error) => {
                error!(%error, "Failed to register session");
                send_state(&mut sink, SessionState::Closed, "Internal server error").await;
                return;
            }
        };
        let session_id: Uuid = session_handle.lock().await.id();
        if let Some(ticket_id) = ticket_id {
            session_handle.lock().await.set_ticket(ticket_id).await;
        }
        if let Err(error) = session_handle.lock().await.set_user_info(user_info).await {
            error!(%error, "Failed to set user info");
        }
        if let Err(error) = session_handle.lock().await.set_target(&target).await {
            error!(%error, "Failed to set target");
        }

        send_state(
            &mut sink,
            SessionState::Connecting,
            "Connecting to the target",
        )
        .await;
        let upstream_user = login.username.clone();
        let clipboard = allow_clipboard.load(Ordering::Relaxed);
        let size = query.width.zip(query.height);
        let Some(handles) = connect_backend(&target.options, login, clipboard, size) else {
            send_state(
                &mut sink,
                SessionState::Closed,
                "This target is not a desktop",
            )
            .await;
            cleanup_empty_session(&services, session_id).await;
            return;
        };
        let DesktopClientHandles {
            event_rx,
            input_tx,
            abort_tx,
        } = handles;

        info!(
            %session_id,
            username = %username,
            target = %target.name,
            protocol = "desktop",
            "desktop_session_started"
        );
        session_handle.lock().await.audit_target_connected().await;

        let recorder = match services
            .recordings
            .lock()
            .await
            .start_desktop(&session_id)
            .await
        {
            Ok(recorder) => {
                recorder.set_record_keyboard(record_keystrokes);
                Some(Arc::new(recorder))
            }
            Err(error) => {
                debug!(%error, "Recording not available (may be disabled)");
                None
            }
        };

        let started = Instant::now();
        let screen = Arc::new(Mutex::new(Screen::default()));
        let wake = Arc::new(Notify::new());
        let connected = ServerMessage::State {
            state: SessionState::Connected,
            message: None,
            details: Some(ConnectedDetails {
                session_id: session_id.to_string(),
                address,
                username: upstream_user,
                clipboard,
            }),
        };

        let _pump = AbortOnDrop(tokio::spawn(pump_events(
            event_rx,
            screen.clone(),
            wake.clone(),
            recorder.clone(),
            allow_clipboard.clone(),
            connected,
        )));
        let output = tokio::spawn(send_screen(sink, screen, wake, close));
        let input = tokio::spawn(forward_input(
            source,
            input_tx,
            recorder,
            allow_clipboard,
            record_keystrokes,
        ));
        let (output_abort, input_abort) = (output.abort_handle(), input.abort_handle());
        tokio::select! {
            _ = output => {},
            _ = input => {},
        }
        output_abort.abort();
        input_abort.abort();
        let _ = abort_tx.send(());

        info!(
            %session_id,
            username = %username,
            target = %target.name,
            protocol = "desktop",
            duration_ms = started.elapsed().as_millis() as u64,
            "desktop_session_ended"
        );
    })
    .into_response()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    const fn rect(x: u16, y: u16, width: u16, height: u16) -> DesktopRect {
        DesktopRect {
            x,
            y,
            width,
            height,
        }
    }

    fn raw(rect: DesktopRect, bgra: [u8; 4]) -> DesktopEvent {
        let pixels = usize::from(rect.width) * usize::from(rect.height);
        DesktopEvent::RawImage {
            rect,
            data: bgra.repeat(pixels).into(),
        }
    }

    fn text(message: &Message) -> serde_json::Value {
        match message {
            Message::Text(text) => serde_json::from_str(text).unwrap(),
            other => panic!("not text: {other:?}"),
        }
    }

    fn screen(width: u16, height: u16) -> Screen {
        let mut screen = Screen::default();
        screen.apply(DesktopEvent::Resize { width, height }, false);
        screen.take();
        screen
    }

    #[test]
    fn a_resize_is_announced_and_pixels_follow_when_painted() {
        let mut screen = Screen::default();
        screen.apply(
            DesktopEvent::Resize {
                width: 100,
                height: 50,
            },
            false,
        );
        let Pending {
            messages,
            regions,
            ended,
        } = screen.take();
        assert_eq!(text(&messages[0])["type"], "resize");
        assert!(regions.is_empty());
        assert!(!ended);

        screen.apply(raw(rect(0, 0, 100, 50), [1, 2, 3, 255]), false);
        let regions = screen.take().regions;
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].1.len(), 100 * 50 * 4);
    }

    #[test]
    fn updates_a_slow_viewer_missed_are_sent_once() {
        let mut screen = screen(640, 480);
        for shade in 0..200u8 {
            screen.apply(raw(rect(0, 0, 640, 480), [shade, 0, 0, 255]), false);
        }
        let Pending {
            messages, regions, ..
        } = screen.take();
        assert!(messages.is_empty());
        assert_eq!(regions.len(), 1);
        // The latest pixels, as RGBA.
        assert_eq!(&regions[0].1[..4], &[0, 0, 199, 255]);
        assert!(screen.take().regions.is_empty());
    }

    #[test]
    fn only_the_latest_of_each_kind_of_notice_is_kept() {
        let mut screen = screen(64, 64);
        for size in [100, 200, 300] {
            screen.apply(
                DesktopEvent::Resize {
                    width: size,
                    height: size,
                },
                true,
            );
            screen.apply(DesktopEvent::Clipboard(format!("clip {size}")), true);
            screen.apply(DesktopEvent::Bell, true);
            screen.apply(DesktopEvent::CursorHidden, true);
        }
        let messages = screen.take().messages;
        let messages: Vec<_> = messages.iter().map(text).collect();
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["width"], 300);
        assert_eq!(messages[1]["text"], "clip 300");
        assert_eq!(messages[2]["type"], "bell");
        assert_eq!(messages[3]["type"], "cursor_hidden");
    }

    #[test]
    fn error_notices_are_bounded() {
        let mut screen = screen(64, 64);
        for n in 0..1000 {
            screen.apply(DesktopEvent::Error(format!("error {n}")), false);
        }
        assert_eq!(screen.take().messages.len(), MAX_QUEUED_NOTICES);
    }

    #[test]
    fn the_target_clipboard_is_dropped_unless_allowed() {
        let mut screen = screen(64, 64);
        screen.apply(DesktopEvent::Clipboard("secret".into()), false);
        assert!(screen.take().messages.is_empty());

        screen.apply(
            DesktopEvent::Clipboard("x".repeat(MAX_CLIPBOARD_BYTES + 10)),
            true,
        );
        let messages = screen.take().messages;
        assert_eq!(
            text(&messages[0])["text"].as_str().unwrap().len(),
            MAX_CLIPBOARD_BYTES
        );
    }

    #[test]
    fn the_cursor_shape_is_sent_as_rgba_with_its_hotspot() {
        let mut screen = screen(64, 64);
        screen.apply(
            DesktopEvent::Cursor {
                rect: rect(2, 3, 1, 1),
                data: Bytes::from_static(&[10, 20, 30, 40]),
            },
            false,
        );
        let messages = screen.take().messages;
        match &messages[0] {
            Message::Binary(frame) => {
                assert_eq!(
                    &frame[..],
                    &[IMAGE_CURSOR, 2, 0, 3, 0, 1, 0, 1, 0, 30, 20, 10, 40]
                );
            }
            other => panic!("not binary: {other:?}"),
        }
    }

    #[tokio::test]
    async fn small_regions_stay_raw_and_large_ones_become_jpeg() {
        let small = Rect {
            x: 1,
            y: 2,
            width: 8,
            height: 8,
        };
        match region_frame(small, vec![7; 8 * 8 * 4]).await.unwrap() {
            Message::Binary(frame) => {
                assert_eq!(frame[0], IMAGE_RAW);
                assert_eq!(frame.len(), 9 + 8 * 8 * 4);
            }
            other => panic!("not binary: {other:?}"),
        }

        let large = Rect {
            x: 0,
            y: 0,
            width: 64,
            height: 64,
        };
        match region_frame(large, vec![7; 64 * 64 * 4]).await.unwrap() {
            Message::Binary(frame) => {
                assert_eq!(frame[0], IMAGE_JPEG);
                assert_eq!(&frame[9..11], &[0xff, 0xd8]);
            }
            other => panic!("not binary: {other:?}"),
        }
    }

    #[test]
    fn sessions_are_capped_per_user_and_released_on_drop() {
        let user = format!("slot-test-{}", Uuid::new_v4());
        let slots: Vec<_> = (0..MAX_SESSIONS_PER_USER)
            .map(|_| SessionSlot::acquire(&user).unwrap())
            .collect();
        assert!(SessionSlot::acquire(&user).is_none());
        drop(slots);
        assert!(SessionSlot::acquire(&user).is_some());
    }

    #[test]
    fn target_names_are_restricted() {
        assert!(validate_target_name("desk-01.lab"));
        assert!(!validate_target_name(""));
        assert!(!validate_target_name("a/b"));
        assert!(!validate_target_name(&"a".repeat(MAX_TARGET_NAME_LEN + 1)));
    }
}
