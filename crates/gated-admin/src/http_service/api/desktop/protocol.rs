//! Wire format of the desktop WebSocket.
//!
//! Text frames carry JSON control messages in both directions. Binary frames
//! go to the viewer only and carry pixels:
//! `[kind: u8][x, y, width, height: u16 LE][data]`.

use gated_core::{DesktopInput, Scancode};
use serde::{Deserialize, Serialize};

/// `data` is RGBA, `width * height * 4` bytes.
pub(super) const IMAGE_RAW: u8 = 1;
/// `data` is a JPEG.
pub(super) const IMAGE_JPEG: u8 = 2;
/// The pointer shape as RGBA; `x` and `y` are its hotspot.
pub(super) const IMAGE_CURSOR: u8 = 3;

pub(super) fn image_frame(
    kind: u8,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    data: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + data.len());
    out.push(kind);
    for value in [x, y, width, height] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(data);
    out
}

/// A message from the viewer.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ClientMessage {
    PointerEvent {
        x: u16,
        y: u16,
        buttons: u8,
    },
    /// `keysym` is the character under the viewer's layout, `scancode` the
    /// physical key (PC/AT set 1). The viewer sends what it knows.
    KeyEvent {
        #[serde(default)]
        keysym: Option<u32>,
        #[serde(default)]
        scancode: Option<u8>,
        #[serde(default)]
        extended: bool,
        down: bool,
    },
    WheelEvent {
        x: u16,
        y: u16,
        vertical: bool,
        delta: i16,
    },
    Clipboard {
        text: String,
    },
    Refresh,
    Resize {
        width: u16,
        height: u16,
    },
}

impl From<ClientMessage> for DesktopInput {
    fn from(message: ClientMessage) -> Self {
        match message {
            ClientMessage::PointerEvent { x, y, buttons } => Self::Pointer { x, y, buttons },
            ClientMessage::KeyEvent {
                keysym,
                scancode,
                extended,
                down,
            } => Self::Key {
                keysym,
                scancode: scancode.map(|code| Scancode { code, extended }),
                down,
            },
            ClientMessage::WheelEvent {
                x,
                y,
                vertical,
                delta,
            } => Self::Wheel {
                x,
                y,
                vertical,
                delta,
            },
            ClientMessage::Clipboard { text } => Self::Clipboard(text),
            ClientMessage::Refresh => Self::Refresh,
            ClientMessage::Resize { width, height } => Self::Resize { width, height },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum SessionState {
    Connecting,
    Connected,
    /// The session is over; `message` says why.
    Closed,
}

/// Facts about an established session, sent with the `connected` state.
#[derive(Debug, Clone, Serialize)]
pub(super) struct ConnectedDetails {
    pub session_id: String,
    /// Target `host:port`.
    pub address: String,
    /// Target account; empty for VNC.
    pub username: String,
    /// Whether clipboard text is passed on, in both directions.
    pub clipboard: bool,
}

/// A control message to the viewer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ServerMessage {
    State {
        state: SessionState,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<ConnectedDetails>,
    },
    Resize {
        width: u16,
        height: u16,
    },
    Clipboard {
        text: String,
    },
    Bell,
    /// A notice; the session ends through `State` alone.
    Error {
        message: String,
    },
    /// The pointer is the viewer's own again.
    CursorDefault,
    CursorHidden,
}

impl ServerMessage {
    pub(super) fn state(state: SessionState, message: &str) -> Self {
        Self::State {
            state,
            message: Some(message.to_owned()),
            details: None,
        }
    }

    pub(super) fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn input(json: &str) -> DesktopInput {
        serde_json::from_str::<ClientMessage>(json).unwrap().into()
    }

    #[test]
    fn parses_viewer_messages() {
        assert!(matches!(
            input(r#"{"type":"pointer_event","x":3,"y":4,"buttons":1}"#),
            DesktopInput::Pointer {
                x: 3,
                y: 4,
                buttons: 1
            }
        ));
        assert!(matches!(
            input(r#"{"type":"key_event","keysym":97,"down":true}"#),
            DesktopInput::Key {
                keysym: Some(97),
                scancode: None,
                down: true
            }
        ));
        assert!(matches!(
            input(r#"{"type":"key_event","scancode":28,"extended":true,"down":false}"#),
            DesktopInput::Key {
                keysym: None,
                scancode: Some(Scancode {
                    code: 28,
                    extended: true
                }),
                down: false
            }
        ));
        assert!(matches!(
            input(r#"{"type":"wheel_event","x":1,"y":2,"vertical":true,"delta":-1}"#),
            DesktopInput::Wheel {
                vertical: true,
                delta: -1,
                ..
            }
        ));
        assert!(matches!(
            input(r#"{"type":"refresh"}"#),
            DesktopInput::Refresh
        ));
        assert!(matches!(
            input(r#"{"type":"resize","width":800,"height":600}"#),
            DesktopInput::Resize {
                width: 800,
                height: 600
            }
        ));
    }

    #[test]
    fn rejects_malformed_viewer_messages() {
        for json in [
            r#"{"type":"pointer_event","x":70000,"y":0,"buttons":0}"#,
            r#"{"type":"pointer_event","x":-1,"y":0,"buttons":0}"#,
            r#"{"type":"unknown"}"#,
            r#"{"type":"key_event"}"#,
            "[]",
        ] {
            assert!(
                serde_json::from_str::<ClientMessage>(json).is_err(),
                "{json}"
            );
        }
    }

    #[test]
    fn control_messages_are_tagged_json() {
        assert_eq!(ServerMessage::Bell.json(), r#"{"type":"bell"}"#);
        assert_eq!(
            ServerMessage::state(SessionState::Closed, "bye").json(),
            r#"{"type":"state","state":"closed","message":"bye"}"#
        );
        assert_eq!(
            ServerMessage::Resize {
                width: 2,
                height: 1
            }
            .json(),
            r#"{"type":"resize","width":2,"height":1}"#
        );
    }

    #[test]
    fn image_frames_carry_a_little_endian_header() {
        assert_eq!(
            image_frame(IMAGE_JPEG, 0x0102, 3, 4, 0x0506, &[9, 9]),
            [2, 2, 1, 3, 0, 4, 0, 6, 5, 9, 9]
        );
    }
}
