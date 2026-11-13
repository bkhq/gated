//! Text clipboard over the RDP clipboard channel (MS-RDPECLIP). Files and
//! images are not offered and not accepted.

use std::any::Any;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use ironrdp_cliprdr::backend::{ClipboardMessage, CliprdrBackend};
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp_core::{AsAny, IntoOwned as _};
use tokio::sync::mpsc::UnboundedSender;
use tracing::debug;

/// The largest clipboard text accepted in either direction, measured as it
/// travels (UTF-16). The same limit the bridge and the VNC client apply.
pub const MAX_RDP_CLIPBOARD_BYTES: usize = 1024 * 1024;

/// What the clipboard channel asks the session loop to do. The loop owns
/// the transport, so the channel backend cannot send by itself.
#[derive(Debug)]
pub enum ClipboardOut {
    /// Send this on the clipboard channel.
    Request(ClipboardMessage),
    /// The target's clipboard text, for the viewer.
    Text(String),
}

/// Cut `text` so its UTF-16 form fits in `max` bytes.
fn truncate_for_wire(text: &mut String, max: usize) {
    let mut wire = 0;
    for (index, character) in text.char_indices() {
        wire += character.len_utf16() * 2;
        if wire > max {
            text.truncate(index);
            return;
        }
    }
}

fn preferred_text_format(formats: &[ClipboardFormat]) -> Option<ClipboardFormatId> {
    [
        ClipboardFormatId::CF_UNICODETEXT,
        ClipboardFormatId::CF_TEXT,
        ClipboardFormatId::CF_OEMTEXT,
    ]
    .into_iter()
    .find(|id| formats.iter().any(|format| format.id() == *id))
}

#[derive(Clone, Debug, Default)]
struct ClipboardText(Arc<Mutex<String>>);

impl ClipboardText {
    fn get(&self) -> String {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set(&self, text: String) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = text;
    }
}

/// The session loop's end of the clipboard: holds the viewer's text until
/// the target asks for it.
#[derive(Clone, Debug)]
pub struct Clipboard {
    store: ClipboardText,
    /// Set once the channel finished its start-up exchange. An offer sent
    /// before that wedges the target's clipboard for the whole session.
    ready: Arc<AtomicBool>,
    out: UnboundedSender<ClipboardOut>,
}

impl Clipboard {
    pub fn new(out: UnboundedSender<ClipboardOut>) -> Self {
        Self {
            store: ClipboardText::default(),
            ready: Arc::new(AtomicBool::new(false)),
            out,
        }
    }

    /// The channel backend to register with the connector.
    pub fn backend(&self) -> TextClipboard {
        TextClipboard {
            store: self.store.clone(),
            ready: Arc::clone(&self.ready),
            out: self.out.clone(),
            paste_format: None,
        }
    }

    /// Put the viewer's text on the target's clipboard.
    pub fn offer(&self, mut text: String) {
        truncate_for_wire(&mut text, MAX_RDP_CLIPBOARD_BYTES);
        self.store.set(text);
        if self.ready.load(Ordering::SeqCst) {
            advertise_text(&self.out);
        }
    }
}

fn advertise_text(out: &UnboundedSender<ClipboardOut>) {
    let _ = out.send(ClipboardOut::Request(ClipboardMessage::SendInitiateCopy(
        vec![ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)],
    )));
}

#[derive(Debug)]
pub struct TextClipboard {
    store: ClipboardText,
    ready: Arc<AtomicBool>,
    out: UnboundedSender<ClipboardOut>,
    paste_format: Option<ClipboardFormatId>,
}

impl TextClipboard {
    fn request(&self, message: ClipboardMessage) {
        let _ = self.out.send(ClipboardOut::Request(message));
    }
}

impl AsAny for TextClipboard {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

impl CliprdrBackend for TextClipboard {
    fn temporary_directory(&self) -> &str {
        "."
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {
        // Text offered while the channel was starting was stored but not
        // announced. If the start-up format list already carried it, this
        // repeats one identical list, which is allowed.
        if !self.ready.swap(true, Ordering::SeqCst) && !self.store.get().is_empty() {
            advertise_text(&self.out);
        }
    }

    fn on_request_format_list(&mut self) {
        if self.store.get().is_empty() {
            self.request(ClipboardMessage::SendInitiateCopy(vec![]));
        } else {
            advertise_text(&self.out);
        }
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        _capabilities: ClipboardGeneralCapabilityFlags,
    ) {
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        if let Some(format) = preferred_text_format(available_formats) {
            self.paste_format = Some(format);
            self.request(ClipboardMessage::SendInitiatePaste(format));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = if request.format == ClipboardFormatId::CF_UNICODETEXT {
            FormatDataResponse::new_unicode_string(&self.store.get())
        } else {
            FormatDataResponse::new_error()
        };
        self.request(ClipboardMessage::SendFormatData(response.into_owned()));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            debug!("target failed to render its clipboard text");
            return;
        }
        let format = self
            .paste_format
            .take()
            .unwrap_or(ClipboardFormatId::CF_UNICODETEXT);
        let decoded = if format == ClipboardFormatId::CF_UNICODETEXT {
            response.to_unicode_string()
        } else {
            response.to_string()
        };
        match decoded {
            Ok(mut text) => {
                truncate_for_wire(&mut text, MAX_RDP_CLIPBOARD_BYTES);
                let _ = self.out.send(ClipboardOut::Text(text));
            }
            Err(error) => debug!(%error, "undecodable clipboard text"),
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}
    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}
    fn on_lock(&mut self, _data_id: LockDataId) {}
    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

    use super::*;

    fn fixture() -> (Clipboard, TextClipboard, UnboundedReceiver<ClipboardOut>) {
        let (out, out_rx) = unbounded_channel();
        let clipboard = Clipboard::new(out);
        let backend = clipboard.backend();
        (clipboard, backend, out_rx)
    }

    /// A clipboard whose channel has finished starting.
    fn ready_fixture() -> (Clipboard, TextClipboard, UnboundedReceiver<ClipboardOut>) {
        let (clipboard, mut backend, out) = fixture();
        backend.on_ready();
        (clipboard, backend, out)
    }

    fn request(out: &mut UnboundedReceiver<ClipboardOut>) -> Option<ClipboardMessage> {
        match out.try_recv().ok()? {
            ClipboardOut::Request(message) => Some(message),
            ClipboardOut::Text(text) => panic!("expected a request, got text {text:?}"),
        }
    }

    fn text(out: &mut UnboundedReceiver<ClipboardOut>) -> Option<String> {
        match out.try_recv().ok()? {
            ClipboardOut::Text(text) => Some(text),
            ClipboardOut::Request(message) => panic!("expected text, got {message:?}"),
        }
    }

    fn offered_formats(message: Option<ClipboardMessage>) -> Vec<ClipboardFormatId> {
        match message {
            Some(ClipboardMessage::SendInitiateCopy(formats)) => {
                formats.iter().map(ClipboardFormat::id).collect()
            }
            other => panic!("expected a format list, got {other:?}"),
        }
    }

    #[test]
    fn a_text_copy_on_the_target_is_asked_for() {
        let (_clipboard, mut backend, mut out) = ready_fixture();

        backend.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_DIB)]);
        assert!(request(&mut out).is_none());

        backend.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]);
        assert!(matches!(
            request(&mut out),
            Some(ClipboardMessage::SendInitiatePaste(
                ClipboardFormatId::CF_UNICODETEXT
            ))
        ));
    }

    #[test]
    fn ansi_text_is_used_when_there_is_no_unicode_text() {
        let (_clipboard, mut backend, mut out) = ready_fixture();

        backend.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_TEXT)]);
        assert!(matches!(
            request(&mut out),
            Some(ClipboardMessage::SendInitiatePaste(
                ClipboardFormatId::CF_TEXT
            ))
        ));

        backend.on_format_data_response(FormatDataResponse::new_string("hello"));
        assert_eq!(text(&mut out).as_deref(), Some("hello"));
    }

    #[test]
    fn text_travels_as_utf16() {
        let (clipboard, mut backend, mut out) = ready_fixture();
        clipboard.offer("héllo".to_owned());
        assert_eq!(
            offered_formats(request(&mut out)),
            [ClipboardFormatId::CF_UNICODETEXT]
        );

        backend.on_format_data_request(FormatDataRequest {
            format: ClipboardFormatId::CF_UNICODETEXT,
        });
        let Some(ClipboardMessage::SendFormatData(response)) = request(&mut out) else {
            panic!("expected format data");
        };
        // Fed straight back, as if the target answered our own request.
        backend.on_format_data_response(response);
        assert_eq!(text(&mut out).as_deref(), Some("héllo"));
    }

    #[test]
    fn a_request_for_anything_but_text_is_refused() {
        let (clipboard, mut backend, mut out) = ready_fixture();
        clipboard.offer("secret".to_owned());
        let _ = request(&mut out);

        backend.on_format_data_request(FormatDataRequest {
            format: ClipboardFormatId::CF_DIB,
        });
        let Some(ClipboardMessage::SendFormatData(response)) = request(&mut out) else {
            panic!("expected format data");
        };
        assert!(response.is_error());
        assert!(response.data().is_empty());
    }

    #[test]
    fn long_text_is_cut_by_its_size_on_the_wire() {
        let (clipboard, _backend, _out) = ready_fixture();
        clipboard.offer("🦀".repeat(MAX_RDP_CLIPBOARD_BYTES / 3));
        let stored = clipboard.store.get();
        let wire_len = stored.encode_utf16().count() * 2;
        assert!(wire_len <= MAX_RDP_CLIPBOARD_BYTES);
        assert!(wire_len > MAX_RDP_CLIPBOARD_BYTES - 4);
        assert!(stored.ends_with('🦀'));
    }

    #[test]
    fn text_from_the_target_is_cut_as_well() {
        let (_clipboard, mut backend, mut out) = ready_fixture();
        let long = "a".repeat(MAX_RDP_CLIPBOARD_BYTES);
        backend.on_format_data_response(FormatDataResponse::new_unicode_string(&long));
        assert_eq!(
            text(&mut out).map(|text| text.len()),
            Some(MAX_RDP_CLIPBOARD_BYTES / 2)
        );
    }

    #[test]
    fn an_offer_waits_until_the_channel_is_ready() {
        let (clipboard, mut backend, mut out) = fixture();

        clipboard.offer("early".to_owned());
        assert!(request(&mut out).is_none());

        backend.on_ready();
        assert_eq!(
            offered_formats(request(&mut out)),
            [ClipboardFormatId::CF_UNICODETEXT]
        );

        clipboard.offer("later".to_owned());
        assert_eq!(
            offered_formats(request(&mut out)),
            [ClipboardFormatId::CF_UNICODETEXT]
        );
    }

    #[test]
    fn the_start_up_format_list_is_always_answered() {
        let (clipboard, mut backend, mut out) = fixture();
        backend.on_request_format_list();
        assert_eq!(offered_formats(request(&mut out)), []);

        // Nothing was offered, so becoming ready announces nothing.
        backend.on_ready();
        assert!(request(&mut out).is_none());

        clipboard.offer("kept".to_owned());
        let _ = request(&mut out);
        backend.on_request_format_list();
        assert_eq!(
            offered_formats(request(&mut out)),
            [ClipboardFormatId::CF_UNICODETEXT]
        );
    }
}
