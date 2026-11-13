use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::Bytes;
use gated_db_entities::Recording::RecordingKind;
use serde::{Deserialize, Serialize};
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tracing::error;

use super::{Error, Recorder, RecordingWriter, Result};
use crate::protocols::framebuffer::{
    Framebuffer, Rect, decode_jpeg_rgb, decode_png_rgba, encode_png_rgba,
};
use crate::{DesktopEvent, DesktopInput, DesktopRect};

/// Suffix of the seek index stored next to a desktop recording.
pub const DESKTOP_INDEX_SUFFIX: &str = ".index";

const MAX_GOP_BYTES: usize = 2_000_000;
const MAX_GOP_SECONDS: f32 = 10.0;
const PNG_OFFLOAD_ENCODING_ABOVE_SIZE: usize = 64 * 1024;
/// Minimum gap between PNG-encoded delta frames. A busy target emits hundreds
/// of small rects per second; they are composited into the framebuffer and the
/// coalesced dirty region is encoded at most this often.
const MIN_RECORD_FRAME_INTERVAL: f32 = 1.0 / 30.0;

/// A rectangle as serialised in the recording stream. Same shape as the `rect`
/// field of the live desktop WebSocket messages, so one canvas renderer serves
/// live sessions and playback.
#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
pub struct RecordingRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl From<DesktopRect> for RecordingRect {
    fn from(r: DesktopRect) -> Self {
        Self {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        }
    }
}

impl From<Rect> for RecordingRect {
    /// Framebuffer rects are clipped to the surface, which never exceeds
    /// `MAX_DESKTOP_DIM`, so the conversion saturates only on a logic error.
    fn from(r: Rect) -> Self {
        let dim = |v: u32| u16::try_from(v).unwrap_or(u16::MAX);
        Self {
            x: dim(r.x),
            y: dim(r.y),
            width: dim(r.width),
            height: dim(r.height),
        }
    }
}

/// One timestamped line of a desktop recording.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopRecordingItem {
    Resize {
        time: f32,
        width: u16,
        height: u16,
    },
    /// A PNG-encoded rectangle. `keyframe` marks a snapshot of the whole
    /// framebuffer, which playback can seek to.
    PngImage {
        time: f32,
        rect: RecordingRect,
        #[serde(default)]
        keyframe: bool,
        #[serde(with = "gated_common::helpers::serde_base64")]
        data: Bytes,
    },
    JpegImage {
        time: f32,
        rect: RecordingRect,
        #[serde(with = "gated_common::helpers::serde_base64")]
        data: Bytes,
    },
    CopyRect {
        time: f32,
        dst: RecordingRect,
        src_x: u16,
        src_y: u16,
    },
    /// A key press or release from the viewer.
    KeyInput {
        time: f32,
        keysym: u32,
        down: bool,
    },
    /// A key press or release from the viewer, as a PC/AT set-1 scancode.
    ScancodeInput {
        time: f32,
        code: u8,
        extended: bool,
        down: bool,
    },
    /// A pointer move or button change from the viewer.
    PointerInput {
        time: f32,
        x: u16,
        y: u16,
        buttons: u8,
    },
    /// A mouse-wheel scroll from the viewer.
    WheelInput {
        time: f32,
        x: u16,
        y: u16,
        vertical: bool,
        delta: i16,
    },
    /// Text the viewer placed on the target's clipboard.
    ClipboardInput {
        time: f32,
        text: String,
    },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum DesktopRecordingMetadata {
    #[serde(rename = "desktop")]
    Desktop,
}

/// One line of the seek index. It holds positions and timestamps only; pixels
/// and input details stay in the recording itself.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopIndexEntry {
    /// A keyframe's playback time and byte offset into the recording.
    Keyframe {
        time: f32,
        offset: usize,
    },
    Resize {
        time: f32,
        width: u16,
        height: u16,
    },
    /// A viewer input happened at this time.
    Input {
        time: f32,
    },
    /// Last line, written when the recording ends.
    End {
        time: f32,
    },
}

enum DataOut {
    Recording(RecordingWriter),
    #[cfg(test)]
    Memory(Vec<u8>),
}

impl DataOut {
    async fn write(&mut self, line: &[u8]) -> Result<()> {
        match self {
            Self::Recording(writer) => writer.write(line).await,
            #[cfg(test)]
            Self::Memory(buffer) => {
                buffer.extend_from_slice(line);
                Ok(())
            }
        }
    }
}

enum IndexOut {
    None,
    File(Box<BufWriter<File>>),
    #[cfg(test)]
    Memory(Vec<u8>),
}

impl IndexOut {
    async fn write(&mut self, line: &[u8]) -> Result<()> {
        match self {
            Self::None => {}
            Self::File(file) => file.write_all(line).await?,
            #[cfg(test)]
            Self::Memory(buffer) => buffer.extend_from_slice(line),
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<()> {
        if let Self::File(file) = self {
            file.flush().await?;
        }
        Ok(())
    }
}

fn json_line<T: Serialize>(item: &T) -> Result<Vec<u8>> {
    let mut line = serde_json::to_vec(item)?;
    line.push(b'\n');
    Ok(line)
}

/// Guarded by one mutex so event and input writes stay ordered and `offset`
/// always matches the bytes handed to the writer.
struct RecorderState {
    data: DataOut,
    index: IndexOut,
    fb: Framebuffer,
    offset: usize,
    bytes_since_keyframe: usize,
    last_keyframe_time: f32,
    duration: f32,
    /// Pixels blitted but not yet encoded.
    dirty: Option<Rect>,
    last_frame_time: f32,
    rgba_scratch: Vec<u8>,
    png_out: Vec<u8>,
}

impl RecorderState {
    fn new(data: DataOut) -> Self {
        Self {
            data,
            index: IndexOut::None,
            fb: Framebuffer::default(),
            offset: 0,
            bytes_since_keyframe: 0,
            last_keyframe_time: 0.0,
            duration: 0.0,
            dirty: None,
            last_frame_time: 0.0,
            rgba_scratch: Vec::new(),
            png_out: Vec::new(),
        }
    }

    fn mark_dirty(&mut self, rect: Rect) {
        self.dirty = Some(match self.dirty {
            Some(existing) => existing.union(rect),
            None => rect,
        });
    }

    async fn write_item(&mut self, item: &DesktopRecordingItem) -> Result<()> {
        let line = json_line(item)?;
        self.data.write(&line).await?;
        self.offset += line.len();
        self.bytes_since_keyframe += line.len();
        Ok(())
    }

    async fn write_index(&mut self, entry: &DesktopIndexEntry) -> Result<()> {
        self.index.write(&json_line(entry)?).await
    }

    /// PNG-encode `rgba_scratch`, reusing `png_out`. Large encodes run on a
    /// blocking worker.
    async fn encode_scratch(&mut self, width: u32, height: u32) -> Result<Bytes> {
        let rgba = std::mem::take(&mut self.rgba_scratch);
        let mut out = std::mem::take(&mut self.png_out);
        let (rgba, out, result) = if rgba.len() >= PNG_OFFLOAD_ENCODING_ABOVE_SIZE {
            tokio::task::spawn_blocking(move || {
                let result = encode_png_rgba(width, height, &rgba, &mut out);
                (rgba, out, result)
            })
            .await
            .map_err(|error| Error::Codec(error.to_string()))?
        } else {
            let result = encode_png_rgba(width, height, &rgba, &mut out);
            (rgba, out, result)
        };
        self.rgba_scratch = rgba;
        let png = Bytes::copy_from_slice(&out);
        self.png_out = out;
        result?;
        Ok(png)
    }

    /// Encode and write the pending dirty region, if any.
    async fn flush_delta(&mut self, time: f32) -> Result<()> {
        let Some(dirty) = self.dirty.take() else {
            return Ok(());
        };
        let mut rgba = std::mem::take(&mut self.rgba_scratch);
        let region = self.fb.copy_region_rgba(dirty, &mut rgba);
        self.rgba_scratch = rgba;
        let Some(rect) = region else {
            return Ok(());
        };
        let data = self.encode_scratch(rect.width, rect.height).await?;
        self.write_item(&DesktopRecordingItem::PngImage {
            time,
            rect: rect.into(),
            keyframe: false,
            data,
        })
        .await?;
        self.last_frame_time = time;
        Ok(())
    }

    /// Write a snapshot of the whole framebuffer once enough has changed, and
    /// flush the index so a crash loses at most one group of frames.
    async fn maybe_keyframe(&mut self, time: f32) -> Result<()> {
        if self.fb.is_empty() {
            return Ok(());
        }
        let due = self.bytes_since_keyframe >= MAX_GOP_BYTES
            || (time - self.last_keyframe_time) >= MAX_GOP_SECONDS;
        if !due {
            return Ok(());
        }

        let (width, height) = self.fb.size();
        self.rgba_scratch.clear();
        self.rgba_scratch.extend_from_slice(self.fb.rgba());
        let data = self.encode_scratch(width, height).await?;

        let offset = self.offset;
        self.write_item(&DesktopRecordingItem::PngImage {
            time,
            rect: Rect {
                x: 0,
                y: 0,
                width,
                height,
            }
            .into(),
            keyframe: true,
            data,
        })
        .await?;
        self.bytes_since_keyframe = 0;
        self.last_keyframe_time = time;
        // The snapshot already holds any pixels still waiting to be encoded.
        self.dirty = None;
        self.last_frame_time = time;
        self.write_index(&DesktopIndexEntry::Keyframe { time, offset })
            .await?;
        self.index.flush().await
    }

    async fn finish(&mut self) -> Result<()> {
        let time = self.duration;
        self.flush_delta(time).await?;
        self.write_index(&DesktopIndexEntry::End { time }).await?;
        self.index.flush().await
    }
}

pub struct DesktopRecorder {
    started_at: Instant,
    state: Arc<Mutex<RecorderState>>,
    record_keyboard: AtomicBool,
}

impl DesktopRecorder {
    fn with_output(data: DataOut) -> Self {
        Self {
            started_at: Instant::now(),
            state: Arc::new(Mutex::new(RecorderState::new(data))),
            record_keyboard: AtomicBool::new(false),
        }
    }

    /// Keystrokes can be passwords typed into the remote desktop, so they are
    /// left out unless the target asks for them.
    pub fn set_record_keyboard(&self, enabled: bool) {
        self.record_keyboard.store(enabled, Ordering::Relaxed);
    }

    pub(crate) async fn open_index(&self, path: &Path, secure: bool) -> Result<()> {
        let file = File::options().append(true).create(true).open(path).await?;
        if secure {
            gated_common::helpers::fs::secure_file(path)?;
        }
        self.state.lock().await.index = IndexOut::File(Box::new(BufWriter::new(file)));
        Ok(())
    }

    fn time(&self) -> f32 {
        self.started_at.elapsed().as_secs_f32()
    }

    /// Record an event from the target. Events without pixels are ignored.
    pub async fn write_event(&self, event: &DesktopEvent) -> Result<()> {
        let time = self.time();
        let mut st = self.state.lock().await;
        st.duration = st.duration.max(time);

        match event {
            DesktopEvent::Resize { width, height } => {
                // Pending pixels belong to the old size.
                st.flush_delta(time).await?;
                st.fb.resize(u32::from(*width), u32::from(*height));
                st.write_item(&DesktopRecordingItem::Resize {
                    time,
                    width: *width,
                    height: *height,
                })
                .await?;
                st.write_index(&DesktopIndexEntry::Resize {
                    time,
                    width: *width,
                    height: *height,
                })
                .await?;
            }
            DesktopEvent::RawImage { rect, data } => {
                let area = Rect {
                    x: u32::from(rect.x),
                    y: u32::from(rect.y),
                    width: u32::from(rect.width),
                    height: u32::from(rect.height),
                };
                st.fb
                    .blit_bgra(area.x, area.y, area.width, area.height, data);
                st.mark_dirty(area);
                if time - st.last_frame_time >= MIN_RECORD_FRAME_INTERVAL {
                    st.flush_delta(time).await?;
                }
            }
            DesktopEvent::JpegImage { rect, data } => {
                st.flush_delta(time).await?;
                // Composite so keyframes stay accurate; the JPEG itself is
                // written unchanged.
                if let Some((_, _, rgb)) = decode_jpeg_rgb(data) {
                    st.fb.blit_rgb(
                        u32::from(rect.x),
                        u32::from(rect.y),
                        u32::from(rect.width),
                        u32::from(rect.height),
                        &rgb,
                    );
                }
                st.write_item(&DesktopRecordingItem::JpegImage {
                    time,
                    rect: (*rect).into(),
                    data: data.clone(),
                })
                .await?;
            }
            DesktopEvent::PngImage { rect, data } => {
                st.flush_delta(time).await?;
                if let Some((_, _, rgba)) = decode_png_rgba(data) {
                    st.fb.blit_rgba(
                        u32::from(rect.x),
                        u32::from(rect.y),
                        u32::from(rect.width),
                        u32::from(rect.height),
                        &rgba,
                    );
                }
                st.write_item(&DesktopRecordingItem::PngImage {
                    time,
                    rect: (*rect).into(),
                    keyframe: false,
                    data: data.clone(),
                })
                .await?;
            }
            DesktopEvent::CopyRect { dst, src_x, src_y } => {
                // The copy applies after the pixels it moves.
                st.flush_delta(time).await?;
                st.fb.copy_rect(
                    u32::from(dst.x),
                    u32::from(dst.y),
                    u32::from(dst.width),
                    u32::from(dst.height),
                    u32::from(*src_x),
                    u32::from(*src_y),
                );
                st.write_item(&DesktopRecordingItem::CopyRect {
                    time,
                    dst: (*dst).into(),
                    src_x: *src_x,
                    src_y: *src_y,
                })
                .await?;
            }
            DesktopEvent::Cursor { .. }
            | DesktopEvent::CursorDefault
            | DesktopEvent::CursorHidden
            | DesktopEvent::State(_)
            | DesktopEvent::Clipboard(_)
            | DesktopEvent::Bell
            | DesktopEvent::Error(_) => return Ok(()),
        }

        st.maybe_keyframe(time).await
    }

    /// Record a JPEG tile together with the raw pixels it was encoded from,
    /// which saves decoding it again for the keyframe surface.
    pub async fn write_jpeg_with_raw(
        &self,
        rect: DesktopRect,
        jpeg: &Bytes,
        raw_bgra: &[u8],
    ) -> Result<()> {
        let time = self.time();
        let mut st = self.state.lock().await;
        st.duration = st.duration.max(time);

        st.flush_delta(time).await?;
        st.fb.blit_bgra(
            u32::from(rect.x),
            u32::from(rect.y),
            u32::from(rect.width),
            u32::from(rect.height),
            raw_bgra,
        );
        st.write_item(&DesktopRecordingItem::JpegImage {
            time,
            rect: rect.into(),
            data: jpeg.clone(),
        })
        .await?;
        st.maybe_keyframe(time).await
    }

    /// Record an input from the viewer.
    pub async fn write_input(&self, input: &DesktopInput) -> Result<()> {
        if matches!(input, DesktopInput::Key { .. })
            && !self.record_keyboard.load(Ordering::Relaxed)
        {
            return Ok(());
        }
        let time = self.time();
        let item = match input {
            // The keysym is what the user typed; a scancode only names a key
            // position that the target's layout reinterprets.
            DesktopInput::Key {
                keysym: Some(keysym),
                down,
                ..
            } => DesktopRecordingItem::KeyInput {
                time,
                keysym: *keysym,
                down: *down,
            },
            DesktopInput::Key {
                scancode: Some(scancode),
                down,
                ..
            } => DesktopRecordingItem::ScancodeInput {
                time,
                code: scancode.code,
                extended: scancode.extended,
                down: *down,
            },
            DesktopInput::Pointer { x, y, buttons } => DesktopRecordingItem::PointerInput {
                time,
                x: *x,
                y: *y,
                buttons: *buttons,
            },
            DesktopInput::Wheel {
                x,
                y,
                vertical,
                delta,
            } => DesktopRecordingItem::WheelInput {
                time,
                x: *x,
                y: *y,
                vertical: *vertical,
                delta: *delta,
            },
            DesktopInput::Clipboard(text) => DesktopRecordingItem::ClipboardInput {
                time,
                text: text.clone(),
            },
            DesktopInput::Refresh | DesktopInput::Resize { .. } | DesktopInput::Key { .. } => {
                return Ok(());
            }
        };
        let mut st = self.state.lock().await;
        st.duration = st.duration.max(time);
        st.write_item(&item).await?;
        st.write_index(&DesktopIndexEntry::Input { time }).await
    }
}

impl Drop for DesktopRecorder {
    fn drop(&mut self) {
        let state = self.state.clone();
        tokio::spawn(async move {
            if let Err(error) = state.lock().await.finish().await {
                error!(%error, "Failed to finish the desktop recording");
            }
        });
    }
}

impl Recorder for DesktopRecorder {
    fn kind() -> RecordingKind {
        RecordingKind::Desktop
    }

    fn new(writer: RecordingWriter) -> Self {
        Self::with_output(DataOut::Recording(writer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Scancode;

    fn recorder() -> DesktopRecorder {
        let recorder = DesktopRecorder::with_output(DataOut::Memory(Vec::new()));
        recorder.state.try_lock().expect("lock").index = IndexOut::Memory(Vec::new());
        recorder
    }

    async fn output(recorder: &DesktopRecorder) -> (Vec<u8>, Vec<DesktopIndexEntry>) {
        let st = recorder.state.lock().await;
        let data = match &st.data {
            DataOut::Memory(data) => data.clone(),
            DataOut::Recording(_) => panic!("test recorder writes to memory"),
        };
        let index = match &st.index {
            IndexOut::Memory(index) => index
                .split(|b| *b == b'\n')
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_slice(line).expect("index entry"))
                .collect(),
            _ => panic!("test recorder indexes to memory"),
        };
        (data, index)
    }

    fn items(data: &[u8]) -> Vec<DesktopRecordingItem> {
        data.split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).expect("item"))
            .collect()
    }

    fn raw(x: u16, y: u16, width: u16, height: u16) -> DesktopEvent {
        DesktopEvent::RawImage {
            rect: DesktopRect {
                x,
                y,
                width,
                height,
            },
            data: Bytes::from(vec![7u8; usize::from(width) * usize::from(height) * 4]),
        }
    }

    #[test]
    fn item_json_shape() {
        let item = DesktopRecordingItem::JpegImage {
            time: 1.5,
            rect: RecordingRect {
                x: 1,
                y: 2,
                width: 3,
                height: 4,
            },
            data: Bytes::from_static(&[0, 1, 2, 3]),
        };
        let value = serde_json::to_value(&item).expect("json");
        assert_eq!(value["type"], "jpeg_image");
        assert_eq!(value["time"], 1.5);
        assert_eq!(value["rect"]["width"], 3);
        assert!(value["data"].is_string());
    }

    #[tokio::test(start_paused = true)]
    async fn keyframe_offsets_point_at_keyframe_lines() {
        let recorder = recorder();
        recorder
            .write_event(&DesktopEvent::Resize {
                width: 8,
                height: 8,
            })
            .await
            .expect("resize");
        recorder.write_event(&raw(0, 0, 8, 8)).await.expect("frame");
        // Past the keyframe interval: the next event carries a snapshot.
        tokio::time::advance(std::time::Duration::from_secs(11)).await;
        recorder.write_event(&raw(0, 0, 2, 2)).await.expect("frame");

        let (data, index) = output(&recorder).await;
        let offsets: Vec<usize> = index
            .iter()
            .filter_map(|entry| match entry {
                DesktopIndexEntry::Keyframe { offset, .. } => Some(*offset),
                _ => None,
            })
            .collect();
        assert_eq!(offsets.len(), 1);
        for offset in offsets {
            let line = data
                .get(offset..)
                .and_then(|rest| rest.split(|b| *b == b'\n').next())
                .expect("line at offset");
            match serde_json::from_slice(line).expect("item") {
                DesktopRecordingItem::PngImage {
                    keyframe: true,
                    rect,
                    ..
                } => assert_eq!((rect.width, rect.height), (8, 8)),
                other => panic!("offset points at {other:?}"),
            }
        }
        assert!(matches!(
            index.first(),
            Some(DesktopIndexEntry::Resize {
                width: 8,
                height: 8,
                ..
            })
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn bursts_of_raw_frames_are_coalesced() {
        let recorder = recorder();
        recorder
            .write_event(&DesktopEvent::Resize {
                width: 16,
                height: 16,
            })
            .await
            .expect("resize");
        tokio::time::advance(std::time::Duration::from_millis(100)).await;
        // The first frame is due at once; the next two arrive within one
        // frame interval and wait for the end of the recording.
        recorder.write_event(&raw(0, 0, 2, 2)).await.expect("frame");
        recorder.write_event(&raw(4, 4, 2, 2)).await.expect("frame");
        recorder.write_event(&raw(8, 8, 2, 2)).await.expect("frame");
        recorder.state.lock().await.finish().await.expect("finish");

        let (data, index) = output(&recorder).await;
        let rects: Vec<(u16, u16, u16, u16)> = items(&data)
            .into_iter()
            .filter_map(|item| match item {
                DesktopRecordingItem::PngImage { rect, .. } => {
                    Some((rect.x, rect.y, rect.width, rect.height))
                }
                _ => None,
            })
            .collect();
        assert_eq!(rects, vec![(0, 0, 2, 2), (4, 4, 6, 6)]);
        assert!(matches!(index.last(), Some(DesktopIndexEntry::End { .. })));
    }

    #[tokio::test]
    async fn keystrokes_are_recorded_only_when_enabled() {
        let key = DesktopInput::Key {
            keysym: Some(0x61),
            scancode: Some(Scancode {
                code: 0x1e,
                extended: false,
            }),
            down: true,
        };
        let pointer = DesktopInput::Pointer {
            x: 1,
            y: 2,
            buttons: 1,
        };

        let recorder = recorder();
        recorder.write_input(&key).await.expect("key");
        recorder.write_input(&pointer).await.expect("pointer");
        let (data, index) = output(&recorder).await;
        let recorded = items(&data);
        assert_eq!(recorded.len(), 1);
        assert!(matches!(
            recorded.first(),
            Some(DesktopRecordingItem::PointerInput { .. })
        ));
        assert_eq!(index.len(), 1);

        recorder.set_record_keyboard(true);
        recorder.write_input(&key).await.expect("key");
        let (data, _) = output(&recorder).await;
        assert!(matches!(
            items(&data).last(),
            Some(DesktopRecordingItem::KeyInput {
                keysym: 0x61,
                down: true,
                ..
            })
        ));
    }
}
