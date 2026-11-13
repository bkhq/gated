use std::future::Future;

use anyhow::Result;
use gated_common::ListenEndpoint;

mod desktop;
pub mod framebuffer;
mod handle;

pub use desktop::{
    DESKTOP_CONNECT_TIMEOUT, DESKTOP_HANDSHAKE_TIMEOUT, DESKTOP_INPUT_CHANNEL_CAPACITY,
    DesktopClientHandles, DesktopConnectionError, DesktopEvent, DesktopInput, DesktopRect,
    DesktopState, MAX_CLIPBOARD_BYTES, MAX_DESKTOP_DIM, Scancode, check_desktop_size,
    truncate_clipboard_contents, truncate_clipboard_contents_in_place, within_deadline,
};
pub use framebuffer::{Framebuffer, PngEncodeError, Rect, decode_png_rgba};
pub use handle::{GatedServerHandle, SessionHandle};

pub trait ProtocolServer {
    fn name(&self) -> &'static str;
    fn run(self, address: ListenEndpoint) -> impl Future<Output = Result<()>> + Send;
}
