use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use gated_common::Secret;
use gated_core::{
    DESKTOP_CONNECT_TIMEOUT, DESKTOP_HANDSHAKE_TIMEOUT, DESKTOP_INPUT_CHANNEL_CAPACITY,
    DesktopClientHandles, DesktopConnectionError, DesktopEvent, DesktopInput, DesktopRect,
    DesktopState, check_desktop_size, truncate_clipboard_contents_in_place, within_deadline,
};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{Receiver, Sender, UnboundedReceiver, channel, unbounded_channel};
use tokio::time::MissedTickBehavior;
use tracing::{Instrument, debug, error, info_span, warn};
use vnc::{ClientKeyEvent, PixelFormat, VncConnector, VncEncoding, VncError, VncEvent, X11Event};

/// Events waiting for the bridge. A slow viewer stalls the reader, and with
/// it the target, instead of growing a queue.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// How often the target is asked for changes. RFB is pull-based: the server
/// answers a request once something changed, so this bounds the frame rate.
const UPDATE_REQUEST_INTERVAL: Duration = Duration::from_millis(40);

/// The largest clipboard text accepted in either direction; the same limit
/// the RFB decoder applies to what the target sends.
const MAX_VNC_CLIPBOARD_BYTES: usize = 1024 * 1024;

/// Most wheel notches forwarded for one scroll input.
const MAX_WHEEL_NOTCHES: usize = 10;

/// Decoded on the gateway; the cursor is drawn by the viewer.
const ENCODINGS: &[VncEncoding] = &[
    VncEncoding::Tight,
    VncEncoding::Zrle,
    VncEncoding::CopyRect,
    VncEncoding::Raw,
    VncEncoding::CursorPseudo,
    VncEncoding::DesktopSizePseudo,
];

pub struct VncClientOptions {
    pub host: String,
    pub port: u16,
    /// `None`: the target is expected to ask for no authentication.
    pub password: Option<Secret<String>>,
    /// Off: clipboard text crosses in neither direction.
    pub allow_clipboard: bool,
}

/// Connect to a VNC target on a task of its own.
pub fn connect(options: VncClientOptions) -> DesktopClientHandles {
    let (event_tx, event_rx) = channel::<DesktopEvent>(EVENT_CHANNEL_CAPACITY);
    let (input_tx, input_rx) = channel::<DesktopInput>(DESKTOP_INPUT_CHANNEL_CAPACITY);
    let (abort_tx, abort_rx) = unbounded_channel::<()>();

    let span = info_span!("VNC-client", host = %options.host, port = options.port);
    tokio::spawn(
        async move {
            if let Err(error) = run(options, event_tx.clone(), input_rx, abort_rx).await {
                let _ = event_tx.send(DesktopEvent::backend_error(&error)).await;
                error!("VNC client failed: {:#}", anyhow::Error::from(error));
            }
            let _ = event_tx
                .send(DesktopEvent::State(DesktopState::Disconnected))
                .await;
        }
        .instrument(span),
    );

    DesktopClientHandles {
        event_rx,
        input_tx,
        abort_tx,
    }
}

async fn run(
    options: VncClientOptions,
    event_tx: Sender<DesktopEvent>,
    mut input_rx: Receiver<DesktopInput>,
    mut abort_rx: UnboundedReceiver<()>,
) -> Result<(), DesktopConnectionError> {
    let VncClientOptions {
        host,
        port,
        password,
        allow_clipboard,
    } = options;

    event_tx
        .send(DesktopEvent::State(DesktopState::Connecting))
        .await
        .ok();

    let stream = within_deadline(DESKTOP_CONNECT_TIMEOUT, async {
        TcpStream::connect((host, port))
            .await
            .map_err(DesktopConnectionError::Io)
    })
    .await?;

    // Set once the target asks for the password. RFB 3.8 reports a rejected
    // one as free text, so a handshake that fails after this point is taken
    // for a rejection.
    let password_asked = Arc::new(AtomicBool::new(false));
    let mut connector = VncConnector::new(stream).set_auth_method({
        let password_asked = password_asked.clone();
        async move {
            password_asked.store(true, Ordering::Relaxed);
            password
                .map(|password| password.expose_secret().clone())
                .ok_or(VncError::NoPassword)
        }
    });
    for encoding in ENCODINGS {
        connector = connector.add_encoding(*encoding);
    }
    let client = within_deadline(DESKTOP_HANDSHAKE_TIMEOUT, async {
        connector
            .allow_shared(true)
            .set_pixel_format(PixelFormat::bgra())
            .build()
            .map_err(|error| vnc_error(error, false))?
            .try_start()
            .await
            .map_err(|error| vnc_error(error, password_asked.load(Ordering::Relaxed)))?
            .finish()
            .map_err(|error| vnc_error(error, false))
    })
    .await?;

    event_tx
        .send(DesktopEvent::State(DesktopState::Connected))
        .await
        .ok();
    client.input(X11Event::FullRefresh).await.ok();

    let mut update_requests = tokio::time::interval(UPDATE_REQUEST_INTERVAL);
    update_requests.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let result = 'session: loop {
        tokio::select! {
            event = client.recv_event() => {
                let Ok(event) = event else {
                    break Ok(());
                };
                let Some(mapped) = map_event(event, allow_clipboard) else {
                    continue;
                };
                if let DesktopEvent::Resize { width, height } = mapped
                    && let Err(error) = check_desktop_size(width, height)
                {
                    break Err(error);
                }
                if event_tx.send(mapped).await.is_err() {
                    break Ok(());
                }
            }
            input = input_rx.recv() => {
                let Some(input) = input else {
                    break Ok(());
                };
                for event in map_input(input, allow_clipboard) {
                    if let Err(error) = client.input(event).await {
                        warn!(%error, "VNC input failed");
                        break 'session Ok(());
                    }
                }
            }
            _ = update_requests.tick() => {
                if client.input(X11Event::Refresh).await.is_err() {
                    break Ok(());
                }
            }
            _ = abort_rx.recv() => {
                debug!("VNC client aborted");
                break Ok(());
            }
        }
    };

    client.close().await.ok();
    result
}

fn vnc_error(error: VncError, password_asked: bool) -> DesktopConnectionError {
    match error {
        VncError::WrongPassword | VncError::NoPassword => {
            DesktopConnectionError::TargetRejectedCredentials(error.into())
        }
        VncError::General(_) if password_asked => {
            DesktopConnectionError::TargetRejectedCredentials(error.into())
        }
        VncError::IoError(error) => DesktopConnectionError::Io(error),
        error => DesktopConnectionError::Handshake(error.into()),
    }
}

const fn rect_from(rect: vnc::Rect) -> DesktopRect {
    DesktopRect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}

fn map_event(event: VncEvent, allow_clipboard: bool) -> Option<DesktopEvent> {
    Some(match event {
        VncEvent::SetResolution(screen) => DesktopEvent::Resize {
            width: screen.width,
            height: screen.height,
        },
        VncEvent::RawImage(rect, data) => DesktopEvent::RawImage {
            rect: rect_from(rect),
            data: Bytes::from(data),
        },
        VncEvent::JpegImage(rect, data) => DesktopEvent::JpegImage {
            rect: rect_from(rect),
            data: Bytes::from(data),
        },
        VncEvent::Copy(dst, src) => DesktopEvent::CopyRect {
            dst: rect_from(dst),
            src_x: src.x,
            src_y: src.y,
        },
        VncEvent::SetCursor(rect, data) => DesktopEvent::Cursor {
            rect: rect_from(rect),
            data: Bytes::from(data),
        },
        VncEvent::Text(mut text) if allow_clipboard => {
            truncate_clipboard_contents_in_place(&mut text, MAX_VNC_CLIPBOARD_BYTES);
            DesktopEvent::Clipboard(text)
        }
        VncEvent::Bell => DesktopEvent::Bell,
        VncEvent::Error(message) => {
            // The text can carry addresses; the viewer gets a fixed reason.
            error!(%message, "VNC target session error");
            DesktopEvent::backend_error(&DesktopConnectionError::Session(anyhow::anyhow!(message)))
        }
        // The pixel format is fixed by us; a refused clipboard is dropped.
        _ => return None,
    })
}

/// The RFB events for one input. A wheel notch is a press and release of
/// scroll button 4 to 7.
fn map_input(input: DesktopInput, allow_clipboard: bool) -> Vec<X11Event> {
    match input {
        DesktopInput::Pointer { x, y, buttons } => {
            vec![X11Event::PointerEvent((x, y, buttons).into())]
        }
        // RFB has no scancode input.
        DesktopInput::Key { keysym, down, .. } => keysym
            .map(|keycode| X11Event::KeyEvent(ClientKeyEvent { keycode, down }))
            .into_iter()
            .collect(),
        DesktopInput::Wheel {
            x,
            y,
            vertical,
            delta,
        } => {
            let button: u8 = match (vertical, delta >= 0) {
                (true, true) => 0x08,
                (true, false) => 0x10,
                (false, true) => 0x40,
                (false, false) => 0x20,
            };
            let notches = usize::from(delta.unsigned_abs()).clamp(1, MAX_WHEEL_NOTCHES);
            let mut events = Vec::with_capacity(notches * 2);
            for _ in 0..notches {
                events.push(X11Event::PointerEvent((x, y, button).into()));
                events.push(X11Event::PointerEvent((x, y, 0).into()));
            }
            events
        }
        DesktopInput::Clipboard(mut text) if allow_clipboard => {
            truncate_clipboard_contents_in_place(&mut text, MAX_VNC_CLIPBOARD_BYTES);
            vec![X11Event::CopyText(text)]
        }
        DesktopInput::Clipboard(_) => vec![],
        DesktopInput::Refresh => vec![X11Event::FullRefresh],
        // The desktop size belongs to the target.
        DesktopInput::Resize { .. } => vec![],
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn pointer(event: &X11Event) -> (u16, u16, u8) {
        match event {
            X11Event::PointerEvent(event) => (event.position_x, event.position_y, event.bottons),
            other => panic!("not a pointer event: {other:?}"),
        }
    }

    #[test]
    fn a_wheel_notch_is_a_scroll_button_press_and_release() {
        let events = map_input(
            DesktopInput::Wheel {
                x: 3,
                y: 4,
                vertical: true,
                delta: -2,
            },
            false,
        );
        let events: Vec<_> = events.iter().map(pointer).collect();
        assert_eq!(events, [(3, 4, 0x10), (3, 4, 0), (3, 4, 0x10), (3, 4, 0)]);
    }

    #[test]
    fn wheel_notches_are_capped() {
        let events = map_input(
            DesktopInput::Wheel {
                x: 0,
                y: 0,
                vertical: false,
                delta: i16::MIN,
            },
            false,
        );
        assert_eq!(events.len(), MAX_WHEEL_NOTCHES * 2);
        assert_eq!(pointer(&events[0]).2, 0x20);
    }

    #[test]
    fn a_key_without_a_keysym_is_dropped() {
        let key = |keysym| DesktopInput::Key {
            keysym,
            scancode: None,
            down: true,
        };
        assert!(map_input(key(None), true).is_empty());
        assert!(matches!(
            map_input(key(Some(0x61)), true).as_slice(),
            [X11Event::KeyEvent(ClientKeyEvent {
                keycode: 0x61,
                down: true
            })]
        ));
    }

    #[test]
    fn clipboard_crosses_only_when_allowed() {
        assert!(map_input(DesktopInput::Clipboard("secret".into()), false).is_empty());
        assert!(map_event(VncEvent::Text("secret".into()), false).is_none());

        assert!(matches!(
            map_input(DesktopInput::Clipboard("text".into()), true).as_slice(),
            [X11Event::CopyText(text)] if text == "text"
        ));
        assert!(matches!(
            map_event(VncEvent::Text("text".into()), true),
            Some(DesktopEvent::Clipboard(text)) if text == "text"
        ));
    }

    #[test]
    fn clipboard_text_is_capped() {
        let long = "é".repeat(MAX_VNC_CLIPBOARD_BYTES);
        match map_input(DesktopInput::Clipboard(long), true).as_slice() {
            [X11Event::CopyText(text)] => assert_eq!(text.len(), MAX_VNC_CLIPBOARD_BYTES),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn a_resize_request_is_not_forwarded() {
        let input = DesktopInput::Resize {
            width: 800,
            height: 600,
        };
        assert!(map_input(input, true).is_empty());
    }

    #[test]
    fn a_decoder_error_is_not_shown_verbatim() {
        let shown = match map_event(VncEvent::Error("10.0.0.7: connection reset".into()), true) {
            Some(DesktopEvent::Error(message)) => message,
            other => format!("{other:?}"),
        };
        assert_eq!(shown, "Target connection failed: The target session failed");
    }

    /// An RFB 3.8 server without authentication that announces a
    /// `width`x`height` desktop and answers the first update request with one
    /// raw 2x1 rectangle.
    async fn fake_server(width: u16, height: u16) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"RFB 003.008\n").await.unwrap();
            let mut version = [0; 12];
            stream.read_exact(&mut version).await.unwrap();
            // One security type: None.
            stream.write_all(&[1, 1]).await.unwrap();
            assert_eq!(stream.read_u8().await.unwrap(), 1);
            stream.write_u32(0).await.unwrap();
            // ClientInit.
            stream.read_u8().await.unwrap();
            // ServerInit: size, 32-bit true-colour pixel format, name.
            stream.write_u16(width).await.unwrap();
            stream.write_u16(height).await.unwrap();
            stream
                .write_all(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
                .await
                .unwrap();
            stream.write_u32(4).await.unwrap();
            stream.write_all(b"fake").await.unwrap();

            // Skip client messages up to the first update request.
            loop {
                match stream.read_u8().await {
                    // SetPixelFormat
                    Ok(0) => {
                        let mut rest = [0; 19];
                        stream.read_exact(&mut rest).await.unwrap();
                    }
                    // SetEncodings
                    Ok(2) => {
                        stream.read_u8().await.unwrap();
                        let count = stream.read_u16().await.unwrap();
                        let mut rest = vec![0; usize::from(count) * 4];
                        stream.read_exact(&mut rest).await.unwrap();
                    }
                    // FramebufferUpdateRequest
                    Ok(3) => {
                        let mut rest = [0; 9];
                        stream.read_exact(&mut rest).await.unwrap();
                        break;
                    }
                    _ => return,
                }
            }
            // FramebufferUpdate: one raw rectangle at (1, 0), 2x1.
            stream.write_all(&[0, 0, 0, 1]).await.unwrap();
            for value in [1u16, 0, 2, 1] {
                stream.write_u16(value).await.unwrap();
            }
            stream.write_i32(0).await.unwrap();
            stream
                .write_all(&[1, 2, 3, 255, 4, 5, 6, 255])
                .await
                .unwrap();
            // Hold the connection until the client leaves.
            let mut sink = [0; 256];
            while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {}
        });
        port
    }

    fn options(port: u16) -> VncClientOptions {
        VncClientOptions {
            host: "127.0.0.1".into(),
            port,
            password: None,
            allow_clipboard: false,
        }
    }

    async fn next(handles: &mut DesktopClientHandles) -> DesktopEvent {
        tokio::time::timeout(Duration::from_secs(10), handles.event_rx.recv())
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn connects_and_delivers_the_first_frame() {
        let port = fake_server(4, 2).await;
        let mut handles = connect(options(port));

        assert!(matches!(
            next(&mut handles).await,
            DesktopEvent::State(DesktopState::Connecting)
        ));
        let mut connected = false;
        let mut resized = false;
        loop {
            match next(&mut handles).await {
                DesktopEvent::State(DesktopState::Connected) => connected = true,
                DesktopEvent::Resize { width, height } => {
                    assert_eq!((width, height), (4, 2));
                    resized = true;
                }
                DesktopEvent::RawImage { rect, data } => {
                    assert_eq!((rect.x, rect.y, rect.width, rect.height), (1, 0, 2, 1));
                    assert_eq!(data.len(), 8);
                    break;
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert!(connected && resized);

        handles.abort_tx.send(()).unwrap();
        loop {
            if matches!(
                next(&mut handles).await,
                DesktopEvent::State(DesktopState::Disconnected)
            ) {
                break;
            }
        }
    }

    async fn failure(port: u16) -> String {
        let mut handles = connect(options(port));
        let mut reason = None;
        loop {
            match next(&mut handles).await {
                DesktopEvent::Error(message) => reason = Some(message),
                DesktopEvent::State(DesktopState::Disconnected) => break,
                _ => {}
            }
        }
        reason.unwrap()
    }

    #[tokio::test]
    async fn an_oversized_desktop_ends_the_session() {
        let port = fake_server(9000, 9000).await;
        assert!(
            failure(port)
                .await
                .starts_with("Target connection failed: ")
        );
    }

    /// An RFB 3.8 server that asks for VNC authentication and rejects the
    /// answer with a reason of its own.
    async fn rejecting_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"RFB 003.008\n").await.unwrap();
            let mut version = [0; 12];
            stream.read_exact(&mut version).await.unwrap();
            // One security type: VNC authentication.
            stream.write_all(&[1, 2]).await.unwrap();
            assert_eq!(stream.read_u8().await.unwrap(), 2);
            stream.write_all(&[7; 16]).await.unwrap();
            let mut response = [0; 16];
            stream.read_exact(&mut response).await.unwrap();
            stream.write_u32(1).await.unwrap();
            let reason = b"password check failed for 10.0.0.7";
            stream.write_u32(reason.len() as u32).await.unwrap();
            stream.write_all(reason).await.unwrap();
        });
        port
    }

    #[tokio::test]
    async fn a_rejected_password_is_reported_as_such() {
        let port = rejecting_server().await;
        let mut handles = connect(VncClientOptions {
            password: Some(Secret::new("wrong".into())),
            ..options(port)
        });
        let mut reason = None;
        loop {
            match next(&mut handles).await {
                DesktopEvent::Error(message) => reason = Some(message),
                DesktopEvent::State(DesktopState::Disconnected) => break,
                _ => {}
            }
        }
        assert_eq!(
            reason.unwrap(),
            "Target connection failed: Target rejected the credentials"
        );
    }

    #[tokio::test]
    async fn a_refused_connection_is_reported_without_the_address() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            failure(port).await,
            "Target connection failed: Target refused the connection"
        );
    }
}
