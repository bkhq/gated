//! The connection to the target: IronRDP's connection sequence and active
//! stage, translated to desktop events and inputs.

use anyhow::{Context, Result, anyhow, bail};
use bytes::Bytes;
use gated_common::Secret;
use gated_core::{
    DESKTOP_CONNECT_TIMEOUT, DESKTOP_HANDSHAKE_TIMEOUT, DESKTOP_INPUT_CHANNEL_CAPACITY,
    DesktopClientHandles, DesktopConnectionError, DesktopEvent, DesktopInput, DesktopRect,
    DesktopState, MAX_DESKTOP_DIM, check_desktop_size, within_deadline,
};
use ironrdp_cliprdr::CliprdrClient;
use ironrdp_cliprdr::backend::ClipboardMessage;
use ironrdp_connector::connection_activation::{
    ConnectionActivationFactory, ConnectionActivationState,
};
use ironrdp_connector::sspi::generator::NetworkRequest;
use ironrdp_connector::{
    self as connector, ConnectionResult, ConnectorError, ConnectorErrorExt as _, ConnectorResult,
    Credentials,
};
use ironrdp_core::WriteBuf;
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp_dvc::DrdynvcClient;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::pointer::DecodedPointer;
use ironrdp_pdu::gcc::{ConnectionType, KeyboardType};
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::rdp::capability_sets::{
    MajorPlatformType, RailSupportLevel, client_codecs_capabilities,
};
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::{FramedWrite as _, NetworkClient, TokioFramed};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{Receiver, Sender, UnboundedReceiver, channel, unbounded_channel};
use tokio_rustls::client::TlsStream;
use tracing::{Instrument, debug, error, info_span, warn};

use crate::clipboard::{Clipboard, ClipboardOut, TextClipboard};
use crate::{input, tls};

type Framed = TokioFramed<TlsStream<TcpStream>>;

/// Events waiting for the bridge. A slow bridge stalls the reader, and with
/// it the target, instead of growing a queue.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// The desktop asked for when the viewer gave no usable size.
const DEFAULT_SIZE: (u16, u16) = (1280, 800);

/// The smallest desktop edge RDP allows (MS-RDPBCGR).
const MIN_DESKTOP_DIM: u16 = 200;

/// The largest desktop, as RGBA bytes: what a viewer may ask for and what a
/// target may report. The gateway holds two copies of it per session.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

pub struct RdpClientOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub domain: Option<String>,
    pub password: Secret<String>,
    /// Check the target's certificate against the system roots and its name.
    pub verify_tls: bool,
    /// Off: the clipboard channel is not opened at all.
    pub allow_clipboard: bool,
    /// The desktop size to ask for, usually the viewer's window.
    pub size: Option<(u16, u16)>,
}

/// Connect to an RDP target on a task of its own.
pub fn connect(options: RdpClientOptions) -> DesktopClientHandles {
    let (event_tx, event_rx) = channel::<DesktopEvent>(EVENT_CHANNEL_CAPACITY);
    let (input_tx, input_rx) = channel::<DesktopInput>(DESKTOP_INPUT_CHANNEL_CAPACITY);
    let (abort_tx, abort_rx) = unbounded_channel::<()>();

    let span = info_span!("RDP-client", host = %options.host, port = options.port);
    tokio::spawn(
        async move {
            if let Err(error) = run(options, event_tx.clone(), input_rx, abort_rx).await {
                let _ = event_tx.send(DesktopEvent::backend_error(&error)).await;
                error!("RDP client failed: {:#}", anyhow::Error::from(error));
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

/// The session ended because the gateway side went away.
struct Aborted;

/// NLA here is NTLM, which needs no network access of its own. A target
/// that insists on Kerberos fails instead of making the gateway reach out
/// to an address the target chose.
struct NoNetwork;

impl NetworkClient for NoNetwork {
    async fn send(&mut self, _request: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
        Err(ConnectorError::general(
            "the target asked for an authentication that needs network access",
        ))
    }
}

/// Make a viewer-supplied size one the target accepts.
fn bound_desktop_size(size: Option<(u16, u16)>) -> (u16, u16) {
    let (width, height) = size.unwrap_or(DEFAULT_SIZE);
    let width = width.clamp(MIN_DESKTOP_DIM, MAX_DESKTOP_DIM);
    let height = height.clamp(MIN_DESKTOP_DIM, MAX_DESKTOP_DIM);
    if usize::from(width) * usize::from(height) * 4 > MAX_FRAME_BYTES {
        warn!(
            width,
            height, "requested desktop is too large; using the default"
        );
        return DEFAULT_SIZE;
    }
    // The layout message rejects odd widths.
    let (width, height) =
        MonitorLayoutEntry::adjust_display_size(u32::from(width), u32::from(height));
    (
        u16::try_from(width).unwrap_or(DEFAULT_SIZE.0),
        u16::try_from(height).unwrap_or(DEFAULT_SIZE.1),
    )
}

/// Refuse a desktop size reported by the target that is empty or larger
/// than the gateway is willing to hold.
fn check_target_size(size: connector::DesktopSize) -> Result<(), DesktopConnectionError> {
    if size.width == 0 || size.height == 0 {
        return Err(DesktopConnectionError::Handshake(anyhow!(
            "the target reported an empty desktop"
        )));
    }
    check_desktop_size(size.width, size.height)?;
    if usize::from(size.width) * usize::from(size.height) * 4 > MAX_FRAME_BYTES {
        return Err(DesktopConnectionError::OversizedDesktop {
            width: size.width,
            height: size.height,
        });
    }
    Ok(())
}

async fn run(
    options: RdpClientOptions,
    event_tx: Sender<DesktopEvent>,
    input_rx: Receiver<DesktopInput>,
    mut abort_rx: UnboundedReceiver<()>,
) -> Result<(), DesktopConnectionError> {
    event_tx
        .send(DesktopEvent::State(DesktopState::Connecting))
        .await
        .ok();

    // Made even when the clipboard is off: it holds the sending half of the
    // channel the session loop waits on, which must not close.
    let (clipboard_tx, clipboard_rx) = unbounded_channel();
    let clipboard = Clipboard::new(clipboard_tx);
    let allow_clipboard = options.allow_clipboard;

    let (connection_result, framed) = within_deadline(
        DESKTOP_HANDSHAKE_TIMEOUT,
        connect_target(&options, allow_clipboard.then(|| clipboard.backend())),
    )
    .await?;

    event_tx
        .send(DesktopEvent::State(DesktopState::Connected))
        .await
        .ok();

    let size = connection_result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    // An abort or a closed channel ends the loop without an error, so what
    // it returns as one is a failure of the session.
    active_loop(
        connection_result,
        framed,
        &mut image,
        input_rx,
        &event_tx,
        &mut abort_rx,
        allow_clipboard.then_some(&clipboard),
        clipboard_rx,
    )
    .await
    .map_err(DesktopConnectionError::Session)
}

async fn connect_target(
    options: &RdpClientOptions,
    clipboard: Option<TextClipboard>,
) -> Result<(ConnectionResult, Framed), DesktopConnectionError> {
    let stream = within_deadline(DESKTOP_CONNECT_TIMEOUT, async {
        TcpStream::connect((options.host.as_str(), options.port))
            .await
            .map_err(DesktopConnectionError::Io)
    })
    .await?;
    stream.set_nodelay(true).ok();
    let client_addr = stream.local_addr().map_err(DesktopConnectionError::Io)?;

    let mut framed = TokioFramed::new(stream);
    let drdynvc = DrdynvcClient::new()
        .with_dynamic_channel(DisplayControlClient::new(|_capabilities| Ok(Vec::new())));
    let mut connector = connector::ClientConnector::new(build_config(options), client_addr)
        .with_static_channel(drdynvc);
    if let Some(clipboard) = clipboard {
        connector.attach_static_channel(CliprdrClient::new(Box::new(clipboard)));
    }

    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector)
        .await
        .map_err(|error| connector_error("connect_begin", error))?;

    let (stream, server_public_key) = tls::upgrade(
        framed.into_inner_no_leftover(),
        &options.host,
        options.verify_tls,
    )
    .await
    .map_err(DesktopConnectionError::Tls)?;

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = TokioFramed::new(stream);
    let connection_result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut NoNetwork,
        options.host.clone().into(),
        server_public_key,
        None,
    )
    .await
    .and_then(connector::ConnectionOutcome::into_connected)
    .map_err(|error| connector_error("connect_finalize", error))?;

    check_target_size(connection_result.desktop_size)?;

    Ok((connection_result, framed))
}

fn connector_error(step: &'static str, error: ConnectorError) -> DesktopConnectionError {
    let rejected = matches!(
        error.kind(),
        connector::ConnectorErrorKind::Credssp(_) | connector::ConnectorErrorKind::AccessDenied
    );
    let chain = anyhow::Error::from(error).context(step);
    if rejected {
        DesktopConnectionError::TargetRejectedCredentials(chain)
    } else {
        DesktopConnectionError::Handshake(chain)
    }
}

fn build_config(options: &RdpClientOptions) -> connector::Config {
    let (width, height) = bound_desktop_size(options.size);
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: options.username.clone(),
            password: options.password.expose_secret().clone(),
        },
        domain: options.domain.clone().filter(|domain| !domain.is_empty()),
        // TLS with network level authentication only: no plain RDP security.
        enable_tls: true,
        enable_credssp: true,
        enable_standard_rdp_security: false,
        keyboard_type: KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize { width, height },
        bitmap: client_codecs_capabilities(&[])
            .ok()
            .map(|codecs| connector::BitmapConfig {
                lossy_compression: false,
                color_depth: 32,
                codecs,
            }),
        client_build: 0,
        client_name: "gated".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        platform: MajorPlatformType::UNIX,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: false,
        enable_audio_capture: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        enable_server_pointer: true,
        pointer_software_rendering: false,
        desktop_scale_factor: 0,
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: None,
        monitor_layout: None,
        monitor_extended_layout: None,
        relative_mouse_input: false,
        connection_type: ConnectionType::Lan,
        remote_application_mode: false,
        rail_support_level: RailSupportLevel::empty(),
        multitransport_flags: None,
        support_dyn_vc_gfx_protocol: false,
    }
}

#[derive(Clone, Copy)]
struct ChannelIds {
    io: u16,
    user: u16,
}

#[derive(Clone, Copy)]
struct RedrawSupport {
    refresh_rect: bool,
    suppress_output: bool,
}

#[expect(clippy::too_many_arguments)]
async fn active_loop(
    connection_result: ConnectionResult,
    mut framed: Framed,
    image: &mut DecodedImage,
    mut input_rx: Receiver<DesktopInput>,
    event_tx: &Sender<DesktopEvent>,
    abort_rx: &mut UnboundedReceiver<()>,
    clipboard: Option<&Clipboard>,
    mut clipboard_rx: UnboundedReceiver<ClipboardOut>,
) -> Result<()> {
    let activation_factory = connection_result.activation_factory;
    let channel_ids = ChannelIds {
        io: connection_result.io_channel_id,
        user: connection_result.user_channel_id,
    };
    let mut redraw = RedrawSupport {
        refresh_rect: connection_result.refresh_rect_support,
        suppress_output: connection_result.suppress_output_support,
    };
    let mut active_stage = ActiveStageBuilder {
        static_channels: connection_result.static_channels,
        user_channel_id: connection_result.user_channel_id,
        io_channel_id: connection_result.io_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }
    .build();
    let mut input_db = ironrdp_input::Database::new();
    // The display control channel works only after the target created it
    // and sent its capabilities, which is after the session became active.
    // A resize asked for earlier waits here and is retried every turn.
    let mut pending_resize: Option<(u32, u32)> = None;
    // The size the target was last asked for. Asking again for the same one
    // would still cost a reactivation.
    let mut requested_size = (u32::from(image.width()), u32::from(image.height()));
    let mut reported_size = None;
    if report_size(image, &mut reported_size, None, event_tx, abort_rx)
        .await
        .is_err()
    {
        return Ok(());
    }

    loop {
        if let Some((width, height)) = pending_resize
            && send_resize(&mut framed, &mut active_stage, width, height).await?
        {
            requested_size = (width, height);
            pending_resize = None;
        }

        let outputs = tokio::select! {
            biased;
            _ = abort_rx.recv() => {
                debug!("RDP client aborted");
                return Ok(());
            }
            input = input_rx.recv() => {
                let Some(first) = input else {
                    return Ok(());
                };
                // Take what else is queued, so a run of pointer moves is one
                // batch. Of several resizes only the last matters: each
                // costs the target a reactivation.
                let mut ops = Vec::new();
                let mut resize = None;
                let mut refresh = false;
                for input in std::iter::once(first)
                    .chain(std::iter::from_fn(|| input_rx.try_recv().ok()))
                {
                    match input {
                        DesktopInput::Resize { width, height } => resize = Some((width, height)),
                        DesktopInput::Refresh => refresh = true,
                        DesktopInput::Clipboard(text) => {
                            if let Some(clipboard) = clipboard {
                                clipboard.offer(text);
                            }
                        }
                        other => input::translate(other, &mut ops),
                    }
                }

                // Clipboard offers go out before the keys of the same batch,
                // so the text is there when Ctrl+V arrives.
                while let Ok(out) = clipboard_rx.try_recv() {
                    if !handle_clipboard_out(out, &mut framed, &mut active_stage, event_tx, abort_rx)
                        .await?
                    {
                        return Ok(());
                    }
                }
                if let Some(size) = resize {
                    let (width, height) = bound_desktop_size(Some(size));
                    let size = (u32::from(width), u32::from(height));
                    pending_resize = (size != requested_size).then_some(size);
                }
                if refresh {
                    let size = connector::DesktopSize {
                        width: image.width(),
                        height: image.height(),
                    };
                    request_full_redraw(&mut framed, &mut active_stage, size, redraw).await?;
                }
                if ops.is_empty() {
                    continue;
                }
                let events = input_db.apply(ops);
                active_stage
                    .process_fastpath_input(image, &events)
                    .context("processing input")?
            }
            out = clipboard_rx.recv() => {
                // `run` keeps the sender for the whole session, so this is
                // never `None`; end the session instead of spinning if that
                // changes.
                let Some(out) = out else {
                    return Ok(());
                };
                if !handle_clipboard_out(out, &mut framed, &mut active_stage, event_tx, abort_rx)
                    .await?
                {
                    return Ok(());
                }
                continue;
            }
            pdu = framed.read_pdu() => {
                let (action, payload) = pdu.context("reading from the target")?;
                let received_at = framed.last_read_at();
                active_stage
                    .process(image, action, &payload, received_at)
                    .context("processing a message of the target")?
            }
        };

        let should_reactivate = outputs
            .iter()
            .any(|output| matches!(output, ActiveStageOutput::DeactivateAll));

        match process_outputs(
            &mut framed,
            image,
            &mut reported_size,
            outputs,
            event_tx,
            abort_rx,
        )
        .await
        {
            Ok(true) | Err(Aborted) => return Ok(()),
            Ok(false) => {}
        }

        // A malformed bitmap was dropped; only the target can repaint it.
        if active_stage.take_bitmap_recovery_request() {
            let size = connector::DesktopSize {
                width: image.width(),
                height: image.height(),
            };
            request_full_redraw(&mut framed, &mut active_stage, size, redraw).await?;
        }

        if should_reactivate
            && let Some(size) = reactivate(
                &mut framed,
                &mut active_stage,
                &activation_factory,
                channel_ids,
                &mut redraw,
                image,
            )
            .await
            .context("reactivating the session")?
        {
            // The viewer's surface is reset by the new size. Seed it with
            // what was there, so it is not blank until the target repaints.
            let keyframe = resized_keyframe(image, size);
            *image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
            if report_size(image, &mut reported_size, keyframe, event_tx, abort_rx)
                .await
                .is_err()
            {
                return Ok(());
            }
            request_full_redraw(&mut framed, &mut active_stage, size, redraw).await?;
        }
    }
}

/// Ask the target for another desktop size over the display control
/// channel. The target answers with a deactivation, which the loop takes
/// through [`reactivate`].
///
/// `false`: the channel is not ready yet and the request should be retried.
async fn send_resize(
    framed: &mut Framed,
    active_stage: &mut ActiveStage,
    width: u32,
    height: u32,
) -> Result<bool> {
    match active_stage.encode_resize(width, height, None, None) {
        Some(frame) => {
            let frame = frame.context("encoding the resize request")?;
            framed
                .write_all(&frame)
                .await
                .context("sending the resize request")?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// `false`: the bridge is gone and the session should end.
async fn handle_clipboard_out(
    out: ClipboardOut,
    framed: &mut Framed,
    active_stage: &mut ActiveStage,
    event_tx: &Sender<DesktopEvent>,
    abort_rx: &mut UnboundedReceiver<()>,
) -> Result<bool> {
    match out {
        ClipboardOut::Request(message) => {
            send_clipboard(framed, active_stage, message).await?;
            Ok(true)
        }
        ClipboardOut::Text(text) => {
            Ok(
                send_event(event_tx, abort_rx, DesktopEvent::Clipboard(text))
                    .await
                    .is_ok(),
            )
        }
    }
}

async fn send_clipboard(
    framed: &mut Framed,
    active_stage: &mut ActiveStage,
    message: ClipboardMessage,
) -> Result<()> {
    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>() else {
        return Ok(());
    };
    let encoded = match message {
        ClipboardMessage::SendInitiateCopy(formats) => cliprdr.initiate_copy(&formats),
        ClipboardMessage::SendInitiatePaste(format) => cliprdr.initiate_paste(format),
        ClipboardMessage::SendFormatData(data) => cliprdr.submit_format_data(data),
        // Files are not transferred.
        other => {
            warn!(?other, "unsupported clipboard operation");
            return Ok(());
        }
    };
    let messages = match encoded {
        Ok(messages) => messages,
        Err(error) => {
            warn!(%error, "failed to encode a clipboard message");
            return Ok(());
        }
    };
    let frame = match active_stage.process_svc_processor_messages(messages) {
        Ok(frame) => frame,
        Err(error) => {
            warn!(%error, "failed to frame a clipboard message");
            return Ok(());
        }
    };
    framed
        .write_all(&frame)
        .await
        .context("sending a clipboard message")
}

/// Run the deactivation-reactivation sequence. Returns the new desktop size
/// when it changed.
async fn reactivate(
    framed: &mut Framed,
    active_stage: &mut ActiveStage,
    activation_factory: &ConnectionActivationFactory,
    channel_ids: ChannelIds,
    redraw: &mut RedrawSupport,
    image: &DecodedImage,
) -> Result<Option<connector::DesktopSize>> {
    let mut activation = activation_factory.create();
    let mut output = WriteBuf::new();

    loop {
        ironrdp_tokio::single_sequence_step(framed, &mut activation, &mut output)
            .await
            .context("driving the reactivation")?;

        let ConnectionActivationState::Finalized {
            desktop_size,
            share_id,
            enable_server_pointer,
            pointer_software_rendering,
            static_channel_chunk_size,
            refresh_rect_support,
            suppress_output_support,
            ..
        } = activation.connection_activation_state()
        else {
            continue;
        };

        *redraw = RedrawSupport {
            refresh_rect: refresh_rect_support,
            suppress_output: suppress_output_support,
        };

        if !active_stage.reactivate(
            channel_ids.io,
            channel_ids.user,
            share_id,
            enable_server_pointer,
            pointer_software_rendering,
            static_channel_chunk_size,
        ) {
            bail!("the target negotiated an invalid channel chunk size");
        }
        check_target_size(desktop_size)?;

        if image.width() != desktop_size.width || image.height() != desktop_size.height {
            debug!(
                from = ?(image.width(), image.height()),
                to = ?(desktop_size.width, desktop_size.height),
                "target reactivated at a new desktop size"
            );
            return Ok(Some(desktop_size));
        }
        return Ok(None);
    }
}

async fn request_full_redraw(
    framed: &mut Framed,
    // Exclusive only because a shared reference to the stage is not `Send`.
    active_stage: &mut ActiveStage,
    size: connector::DesktopSize,
    redraw: RedrawSupport,
) -> Result<()> {
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    let frames = active_stage
        .request_full_redraw(
            size.width,
            size.height,
            redraw.refresh_rect,
            redraw.suppress_output,
        )
        .context("encoding the redraw request")?;
    for frame in frames {
        framed
            .write_all(&frame)
            .await
            .context("requesting a redraw")?;
    }
    Ok(())
}

/// Send what the stage produced: answers to the target, then events to the
/// bridge. `true`: the target ended the session.
async fn process_outputs(
    framed: &mut Framed,
    image: &DecodedImage,
    reported_size: &mut Option<(u16, u16)>,
    outputs: Vec<ActiveStageOutput>,
    event_tx: &Sender<DesktopEvent>,
    abort_rx: &mut UnboundedReceiver<()>,
) -> Result<bool, Aborted> {
    let mut terminate = false;
    for output in &outputs {
        if let ActiveStageOutput::ResponseFrame(frame) = output {
            framed.write_all(frame).await.map_err(|_| Aborted)?;
        } else if let ActiveStageOutput::Terminate(reason) = output {
            debug!(?reason, "target ended the session");
            terminate = true;
        }
    }

    report_size(image, reported_size, None, event_tx, abort_rx).await?;

    for output in outputs {
        let event = match output {
            ActiveStageOutput::GraphicsUpdate(region) => encode_region(image, &region),
            ActiveStageOutput::PointerBitmap(pointer) => encode_pointer(&pointer),
            ActiveStageOutput::PointerDefault => Some(DesktopEvent::CursorDefault),
            ActiveStageOutput::PointerHidden => Some(DesktopEvent::CursorHidden),
            _ => None,
        };
        if let Some(event) = event {
            send_event(event_tx, abort_rx, event).await?;
        }
    }
    Ok(terminate)
}

/// Tell the bridge the desktop size when it differs from the last one told,
/// then send `keyframe`, if any.
async fn report_size(
    image: &DecodedImage,
    reported_size: &mut Option<(u16, u16)>,
    keyframe: Option<DesktopEvent>,
    event_tx: &Sender<DesktopEvent>,
    abort_rx: &mut UnboundedReceiver<()>,
) -> Result<(), Aborted> {
    let size = (image.width(), image.height());
    if *reported_size != Some(size) {
        *reported_size = Some(size);
        send_event(
            event_tx,
            abort_rx,
            DesktopEvent::Resize {
                width: size.0,
                height: size.1,
            },
        )
        .await?;
    }
    if let Some(keyframe) = keyframe {
        send_event(event_tx, abort_rx, keyframe).await?;
    }
    Ok(())
}

async fn send_event(
    event_tx: &Sender<DesktopEvent>,
    abort_rx: &mut UnboundedReceiver<()>,
    event: DesktopEvent,
) -> Result<(), Aborted> {
    tokio::select! {
        biased;
        _ = abort_rx.recv() => Err(Aborted),
        result = event_tx.send(event) => result.map_err(|_| Aborted),
    }
}

/// The pixels of `region` as a BGRA image event. The region is clipped to
/// the image.
fn encode_region(image: &DecodedImage, region: &InclusiveRectangle) -> Option<DesktopEvent> {
    let image_width = usize::from(image.width());
    let image_height = usize::from(image.height());
    if image_width == 0 || image_height == 0 {
        return None;
    }
    let left = usize::from(region.left).min(image_width - 1);
    let top = usize::from(region.top).min(image_height - 1);
    let right = usize::from(region.right).min(image_width - 1);
    let bottom = usize::from(region.bottom).min(image_height - 1);
    if right < left || bottom < top {
        return None;
    }
    let width = right - left + 1;
    let height = bottom - top + 1;

    let mut data = Vec::with_capacity(width * height * 4);
    for row in image
        .data()
        .chunks_exact(image_width * 4)
        .skip(top)
        .take(height)
    {
        for pixel in row.get(left * 4..(left + width) * 4)?.chunks_exact(4) {
            if let [red, green, blue, _] = *pixel {
                data.extend_from_slice(&[blue, green, red, 255]);
            }
        }
    }
    if data.len() != width * height * 4 {
        return None;
    }

    Some(DesktopEvent::RawImage {
        rect: DesktopRect {
            x: u16::try_from(left).ok()?,
            y: u16::try_from(top).ok()?,
            width: u16::try_from(width).ok()?,
            height: u16::try_from(height).ok()?,
        },
        data: Bytes::from(data),
    })
}

/// The target's pointer shape as a BGRA cursor event; the rect's position
/// is the hotspot.
fn encode_pointer(pointer: &DecodedPointer) -> Option<DesktopEvent> {
    if pointer.width == 0 || pointer.height == 0 {
        return Some(DesktopEvent::CursorHidden);
    }
    let len = usize::from(pointer.width) * usize::from(pointer.height) * 4;
    if pointer.bitmap_data.len() != len {
        return None;
    }

    let mut data = Vec::with_capacity(len);
    for pixel in pointer.bitmap_data.chunks_exact(4) {
        if let [red, green, blue, alpha] = *pixel {
            data.extend_from_slice(&[blue, green, red, alpha]);
        }
    }

    Some(DesktopEvent::Cursor {
        rect: DesktopRect {
            x: pointer.hotspot_x.min(pointer.width - 1),
            y: pointer.hotspot_y.min(pointer.height - 1),
            width: pointer.width,
            height: pointer.height,
        },
        data: Bytes::from(data),
    })
}

/// The old screen laid on a black surface of the new size: what overlaps
/// is kept, the rest is black.
fn resized_keyframe(image: &DecodedImage, size: connector::DesktopSize) -> Option<DesktopEvent> {
    let old_width = usize::from(image.width());
    let new_width = usize::from(size.width);
    let new_height = usize::from(size.height);
    if old_width == 0 || image.height() == 0 || new_width == 0 || new_height == 0 {
        return None;
    }

    let mut data = [0u8, 0, 0, 255].repeat(new_width.checked_mul(new_height)?);
    for (source_row, target_row) in image
        .data()
        .chunks_exact(old_width * 4)
        .zip(data.chunks_exact_mut(new_width * 4))
    {
        for (source, target) in source_row
            .chunks_exact(4)
            .zip(target_row.chunks_exact_mut(4))
        {
            if let ([red, green, blue, _], [b, g, r, _]) = (source, target) {
                *b = *blue;
                *g = *green;
                *r = *red;
            }
        }
    }

    Some(DesktopEvent::RawImage {
        rect: DesktopRect {
            x: 0,
            y: 0,
            width: size.width,
            height: size.height,
        },
        data: Bytes::from(data),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn a_requested_size_is_made_acceptable() {
        assert_eq!(bound_desktop_size(None), DEFAULT_SIZE);
        // Odd widths are not allowed, and neither is anything under 200.
        assert_eq!(bound_desktop_size(Some((1281, 801))), (1280, 801));
        assert_eq!(bound_desktop_size(Some((10, 10))), (200, 200));
        // Within the per-edge limit but more pixels than a viewer may ask for.
        assert_eq!(bound_desktop_size(Some((8192, 8192))), DEFAULT_SIZE);
        assert_eq!(bound_desktop_size(Some((u16::MAX, 300))), (8192, 300));
    }

    #[test]
    fn the_session_is_tls_with_nla_and_logs_on_with_the_account() {
        let config = build_config(&RdpClientOptions {
            host: "win".to_owned(),
            port: 3389,
            username: "alice".to_owned(),
            domain: Some(String::new()),
            password: Secret::new("pw".to_owned()),
            verify_tls: true,
            allow_clipboard: false,
            size: Some((1024, 768)),
        });
        assert!(config.enable_tls && config.enable_credssp);
        assert!(!config.enable_standard_rdp_security);
        assert!(config.autologon);
        assert!(config.domain.is_none());
        assert_eq!(
            (config.desktop_size.width, config.desktop_size.height),
            (1024, 768)
        );
        assert!(matches!(
            config.credentials,
            Credentials::UsernamePassword { ref username, ref password }
                if username == "alice" && password == "pw"
        ));
    }

    #[test]
    fn the_desktop_a_target_reports_is_bounded() {
        let size = |width, height| connector::DesktopSize { width, height };
        assert!(check_target_size(size(1920, 1080)).is_ok());
        assert!(check_target_size(size(5120, 2880)).is_ok());
        // Empty, over the per-edge limit, and within it but too many pixels.
        assert!(check_target_size(size(0, 600)).is_err());
        assert!(matches!(
            check_target_size(size(9000, 600)),
            Err(DesktopConnectionError::OversizedDesktop { .. })
        ));
        assert!(matches!(
            check_target_size(size(8192, 8192)),
            Err(DesktopConnectionError::OversizedDesktop { .. })
        ));
    }

    fn image(width: u16, height: u16) -> DecodedImage {
        DecodedImage::new(PixelFormat::RgbA32, width, height)
    }

    #[test]
    fn a_region_is_clipped_to_the_image() {
        let event = encode_region(
            &image(4, 3),
            &InclusiveRectangle {
                left: 2,
                top: 1,
                right: 90,
                bottom: 90,
            },
        );
        assert!(matches!(
            event,
            Some(DesktopEvent::RawImage {
                rect: DesktopRect { x: 2, y: 1, width: 2, height: 2 },
                data,
            }) if data.len() == 2 * 2 * 4 && data.iter().skip(3).step_by(4).all(|alpha| *alpha == 255)
        ));
        assert!(
            encode_region(
                &image(0, 0),
                &InclusiveRectangle {
                    left: 0,
                    top: 0,
                    right: 1,
                    bottom: 1,
                },
            )
            .is_none()
        );
    }

    #[test]
    fn a_resized_keyframe_covers_the_new_desktop() {
        let event = resized_keyframe(
            &image(2, 2),
            connector::DesktopSize {
                width: 4,
                height: 3,
            },
        );
        assert!(matches!(
            event,
            Some(DesktopEvent::RawImage {
                rect: DesktopRect { x: 0, y: 0, width: 4, height: 3 },
                data,
            }) if data.len() == 4 * 3 * 4 && data.iter().skip(3).step_by(4).all(|alpha| *alpha == 255)
        ));
    }

    fn pointer(width: u16, height: u16, bitmap_data: Vec<u8>) -> DecodedPointer {
        DecodedPointer {
            width,
            height,
            hotspot_x: 1,
            hotspot_y: 0,
            bitmap_data,
        }
    }

    #[test]
    fn a_pointer_shape_becomes_a_bgra_cursor_with_its_hotspot() {
        let event = encode_pointer(&pointer(2, 1, vec![1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(matches!(
            event,
            Some(DesktopEvent::Cursor {
                rect: DesktopRect { x: 1, y: 0, width: 2, height: 1 },
                data,
            }) if data[..] == [3, 2, 1, 4, 7, 6, 5, 8]
        ));
    }

    #[test]
    fn a_hotspot_outside_the_pointer_is_clamped() {
        let mut decoded = pointer(1, 1, vec![0; 4]);
        decoded.hotspot_x = 40;
        decoded.hotspot_y = 40;
        assert!(matches!(
            encode_pointer(&decoded),
            Some(DesktopEvent::Cursor {
                rect: DesktopRect { x: 0, y: 0, .. },
                ..
            })
        ));
    }

    #[test]
    fn an_empty_pointer_hides_the_cursor_and_a_short_one_is_dropped() {
        assert!(matches!(
            encode_pointer(&pointer(0, 0, vec![])),
            Some(DesktopEvent::CursorHidden)
        ));
        assert!(encode_pointer(&pointer(2, 2, vec![0; 4])).is_none());
    }

    #[tokio::test]
    async fn an_unreachable_target_is_reported_and_the_session_ends() {
        // A port that was just free: nothing listens there.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut handles = connect(RdpClientOptions {
            host: "127.0.0.1".to_owned(),
            port,
            username: "alice".to_owned(),
            domain: None,
            password: Secret::new("pw".to_owned()),
            verify_tls: true,
            allow_clipboard: false,
            size: None,
        });
        let mut events = vec![];
        while let Some(event) = handles.event_rx.recv().await {
            events.push(event);
        }
        assert!(matches!(
            events.as_slice(),
            [
                DesktopEvent::State(DesktopState::Connecting),
                DesktopEvent::Error(message),
                DesktopEvent::State(DesktopState::Disconnected),
            ] if message == "Target connection failed: Target refused the connection"
        ));
    }

    #[tokio::test]
    async fn a_target_that_does_not_speak_rdp_fails_the_handshake() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = socket.write_all(b"SSH-2.0-not-rdp\r\n").await;
        });

        let mut handles = connect(RdpClientOptions {
            host: "127.0.0.1".to_owned(),
            port,
            username: "alice".to_owned(),
            domain: None,
            password: Secret::new("pw".to_owned()),
            verify_tls: true,
            allow_clipboard: false,
            size: None,
        });
        let mut messages = vec![];
        while let Some(event) = handles.event_rx.recv().await {
            if let DesktopEvent::Error(message) = event {
                messages.push(message);
            }
        }
        assert_eq!(
            messages,
            ["Target connection failed: Protocol negotiation with the target failed"]
        );
    }
}
