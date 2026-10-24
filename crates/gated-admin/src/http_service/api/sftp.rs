//! Web file manager backend: SFTP over the gateway's own SSH client.
//!
//! Endpoints (mounted under `/api`, all require a signed-in user):
//! - `GET  /sftp/{target}/list?path=`               directory listing
//! - `POST /sftp/{target}/mkdir`   `{ path }`
//! - `POST /sftp/{target}/rename`  `{ from, to }`
//! - `POST /sftp/{target}/remove`  `{ path, directory }`
//! - `GET  /sftp/{target}/download?path=`           raw file body
//! - `PUT  /sftp/{target}/upload?path=&overwrite=`  raw request body
//!
//! One SFTP connection is kept per (user, target) and closed after
//! [`IDLE_TIMEOUT`]. Each connection is a gateway session (`WebSFTP`) and every
//! file change or transfer is written to its `file_audit` recording.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::from_fn;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::StreamExt;
use gated_common::auth::AuthStateUserInfo;
use gated_common::web::{Data, Json};
use gated_common::{
    SessionId, SshHostKeyVerificationMode, Target, TargetSSHOptions, api_response, api_routes,
};
use gated_core::recordings::{FileAuditRecorder, FileAuditRecordingItem, FileAuditSessionMetadata};
use gated_core::{ConfigProvider, Services, SessionStateInit, State};
use gated_protocol_ssh::{ChannelOperation, RCCommand, RCEvent, RCState, RemoteClient};
use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpClientError;
use russh_sftp::protocol::{FileType, StatusCode as SftpStatusCode};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify, oneshot};
use tracing::*;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::common::TerminalSessionHandle;
use super::ssh_terminal::{connection_error_message, resolve_and_authorize, sha256_fingerprint};
use crate::http_service::api::AnySecurityScheme;
use crate::http_service::common::{RequestAuthorization, SessionAuthorization, require_auth};

const MAX_TARGET_NAME_LEN: usize = 128;
const MAX_CONNECTIONS_PER_USER: usize = 4;
const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SFTP_REQUEST_TIMEOUT_SECS: u64 = 30;
/// Upload size limit.
pub(crate) const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const IO_CHUNK: usize = 64 * 1024;

#[derive(Serialize, ToSchema)]
pub struct SftpErrorBody {
    error: String,
}

api_response! {
    pub enum SftpError {
        #[oai(status = 400)]
        BadRequest(Json<SftpErrorBody>),
        #[oai(status = 401)]
        Unauthorized(Json<SftpErrorBody>),
        #[oai(status = 403)]
        Forbidden(Json<SftpErrorBody>),
        #[oai(status = 404)]
        NotFound(Json<SftpErrorBody>),
        /// The target's host key is unknown or changed, or the upload target exists.
        #[oai(status = 409)]
        Conflict(Json<SftpErrorBody>),
        #[oai(status = 413)]
        PayloadTooLarge(Json<SftpErrorBody>),
        #[oai(status = 429)]
        TooManyConnections(Json<SftpErrorBody>),
        #[oai(status = 500)]
        Internal(Json<SftpErrorBody>),
        #[oai(status = 502)]
        BadGateway(Json<SftpErrorBody>),
    }
}

fn body(msg: impl Into<String>) -> Json<SftpErrorBody> {
    Json(SftpErrorBody { error: msg.into() })
}

impl SftpError {
    fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(body(msg))
    }

    fn bad_gateway(msg: impl Into<String>) -> Self {
        Self::BadGateway(body(msg))
    }

    fn message(&self) -> String {
        let (Self::BadRequest(b)
        | Self::Unauthorized(b)
        | Self::Forbidden(b)
        | Self::NotFound(b)
        | Self::Conflict(b)
        | Self::PayloadTooLarge(b)
        | Self::TooManyConnections(b)
        | Self::Internal(b)
        | Self::BadGateway(b)) = self;
        b.0.error.clone()
    }
}

/// Map an SFTP client error; transport failures also drop the cached connection.
fn map_sftp_error(err: &SftpClientError) -> SftpError {
    match err {
        SftpClientError::Status(status) => {
            let msg = if status.error_message.is_empty() {
                status.status_code.to_string()
            } else {
                status.error_message.clone()
            };
            match status.status_code {
                SftpStatusCode::NoSuchFile => SftpError::NotFound(body(msg)),
                SftpStatusCode::PermissionDenied => SftpError::Forbidden(body(msg)),
                _ => SftpError::BadRequest(body(msg)),
            }
        }
        other => SftpError::bad_gateway(other.to_string()),
    }
}

fn is_transport_error(err: &SftpClientError) -> bool {
    !matches!(err, SftpClientError::Status(_))
}

fn validate_target_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_TARGET_NAME_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

fn validate_path(path: &str) -> Result<(), SftpError> {
    if path.is_empty() || path.contains('\0') {
        return Err(SftpError::BadRequest(body("Invalid path")));
    }
    Ok(())
}

fn extract_username(auth: &RequestAuthorization) -> Option<String> {
    match auth {
        RequestAuthorization::Session(SessionAuthorization::User(u)) => Some(u.clone()),
        RequestAuthorization::Session(SessionAuthorization::Ticket { username, .. }) => {
            Some(username.clone())
        }
        RequestAuthorization::UserToken { username } => Some(username.clone()),
        _ => None,
    }
}

// --- connections ---------------------------------------------------------

struct SftpConnection {
    sftp: SftpSession,
    session_id: SessionId,
    target: Target,
    user: AuthStateUserInfo,
    close: Arc<Notify>,
    last_used: Arc<std::sync::Mutex<Instant>>,
}

impl SftpConnection {
    fn touch(&self) {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut last_used = self.last_used.lock().unwrap();
        *last_used = Instant::now();
    }
}

type ConnectionKey = (String, String);

static CONNECTIONS: LazyLock<Mutex<HashMap<ConnectionKey, Arc<SftpConnection>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn drop_connection(key: &ConnectionKey, session_id: SessionId) {
    let mut connections = CONNECTIONS.lock().await;
    if let Some(conn) = connections.get(key)
        && conn.session_id == session_id
    {
        conn.close.notify_one();
        connections.remove(key);
    }
}

/// Authorize the request and return a live connection, opening one if needed.
async fn connection(
    services: &Services,
    auth: &RequestAuthorization,
    target_name: &str,
) -> Result<Arc<SftpConnection>, SftpError> {
    if !validate_target_name(target_name) {
        return Err(SftpError::BadRequest(body("Invalid target name")));
    }
    if !auth.permits_target(target_name) {
        return Err(SftpError::Forbidden(body(
            "Ticket does not permit this target",
        )));
    }
    let username =
        extract_username(auth).ok_or_else(|| SftpError::Unauthorized(body("Not authenticated")))?;
    let (target, ssh_options, user) = authorize(services, &username, target_name).await?;

    let key = (username.clone(), target_name.to_owned());
    {
        let connections = CONNECTIONS.lock().await;
        if let Some(conn) = connections.get(&key) {
            conn.touch();
            return Ok(conn.clone());
        }
        if connections.keys().filter(|(u, _)| *u == username).count() >= MAX_CONNECTIONS_PER_USER {
            return Err(SftpError::TooManyConnections(body(
                "Too many concurrent file manager connections",
            )));
        }
    }

    let conn = Arc::new(open_connection(services, target, ssh_options, user, key.clone()).await?);
    let mut connections = CONNECTIONS.lock().await;
    if let Some(existing) = connections.get(&key) {
        // Lost a race with a concurrent request; keep the first connection.
        conn.close.notify_one();
        return Ok(existing.clone());
    }
    connections.insert(key, conn.clone());
    Ok(conn)
}

async fn authorize(
    services: &Services,
    username: &str,
    target_name: &str,
) -> Result<(Target, TargetSSHOptions, AuthStateUserInfo), SftpError> {
    let resolved = resolve_and_authorize(services, username, target_name)
        .await
        .map_err(|msg| match msg {
            "User not found" => SftpError::Unauthorized(body(msg)),
            "Access denied to target" => SftpError::Forbidden(body(msg)),
            "Target not found" => SftpError::NotFound(body(msg)),
            "Target is not an SSH target" => SftpError::BadRequest(body(msg)),
            _ => SftpError::internal(msg),
        })?;
    let allowed = services
        .config_provider
        .lock()
        .await
        .authorize_file_transfer(username, target_name)
        .await
        .map_err(|e| {
            error!(%e, "File transfer authorization failed");
            SftpError::internal("Internal server error")
        })?;
    if !allowed {
        warn!(
            target: "audit",
            username,
            target_name,
            "web_file_transfer_denied"
        );
        return Err(SftpError::Forbidden(body(
            "File transfer is not allowed on this target",
        )));
    }
    Ok(resolved)
}

async fn open_connection(
    services: &Services,
    target: Target,
    ssh_options: TargetSSHOptions,
    user: AuthStateUserInfo,
    key: ConnectionKey,
) -> Result<SftpConnection, SftpError> {
    let close = Arc::new(Notify::new());
    let session_handle = State::register_session(
        &services.state,
        &"WebSFTP",
        SessionStateInit {
            remote_address: None,
            handle: Box::new(TerminalSessionHandle(close.clone())),
        },
    )
    .await
    .map_err(|e| {
        error!(%e, "Failed to register SFTP session");
        SftpError::internal("Internal server error")
    })?;
    let session_id = session_handle.lock().await.id();
    if let Err(e) = session_handle
        .lock()
        .await
        .set_user_info(user.clone())
        .await
    {
        error!(%e, "Failed to set user info");
    }
    if let Err(e) = session_handle.lock().await.set_target(&target).await {
        error!(%e, "Failed to set target");
    }

    let mut handles = RemoteClient::create(session_id, services.clone()).map_err(|e| {
        error!(%e, "Failed to create SSH client");
        SftpError::internal("Internal server error")
    })?;
    let host_key_mode = services.config.read().await.store.ssh.host_key_verification;

    let channel = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        connect_and_open_sftp(&mut handles, ssh_options, host_key_mode),
    )
    .await
    {
        Ok(Ok(channel)) => channel,
        Ok(Err(err)) => {
            let _ = handles.abort_tx.send(());
            return Err(err);
        }
        Err(_) => {
            let _ = handles.abort_tx.send(());
            return Err(SftpError::bad_gateway("Timed out connecting to the target"));
        }
    };

    let (local, remote) = tokio::io::duplex(4 * IO_CHUNK);
    let last_used = Arc::new(std::sync::Mutex::new(Instant::now()));
    tokio::spawn(pump(
        handles,
        channel,
        local,
        close.clone(),
        last_used.clone(),
        key,
        session_id,
        session_handle,
    ));

    let config = russh_sftp::client::Config {
        request_timeout_secs: SFTP_REQUEST_TIMEOUT_SECS,
        ..Default::default()
    };
    let sftp = match SftpSession::new_with_config(remote, config).await {
        Ok(sftp) => sftp,
        Err(e) => {
            close.notify_one();
            return Err(SftpError::bad_gateway(format!(
                "SFTP handshake failed: {e}"
            )));
        }
    };
    info!(%session_id, username = %user.username, target = %target.name, "web_sftp_session_started");

    Ok(SftpConnection {
        sftp,
        session_id,
        target,
        user,
        close,
        last_used,
    })
}

async fn send_and_wait(
    handles: &gated_protocol_ssh::RemoteClientHandles,
    command: RCCommand,
) -> Result<(), SftpError> {
    let (tx, rx) = oneshot::channel();
    handles
        .command_tx
        .send((command, Some(tx)))
        .map_err(|_| SftpError::bad_gateway("SSH connection closed"))?;
    match rx.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(SftpError::bad_gateway(format!("SSH channel failed: {e}"))),
        Err(_) => Err(SftpError::bad_gateway("SSH connection closed")),
    }
}

async fn connect_and_open_sftp(
    handles: &mut gated_protocol_ssh::RemoteClientHandles,
    ssh_options: TargetSSHOptions,
    host_key_mode: SshHostKeyVerificationMode,
) -> Result<Uuid, SftpError> {
    handles
        .command_tx
        .send((RCCommand::Connect(ssh_options), None))
        .map_err(|_| SftpError::internal("Failed to initiate SSH connection"))?;
    loop {
        match handles.event_rx.recv().await {
            Some(RCEvent::State(RCState::Connected)) => break,
            Some(RCEvent::HostKeyUnknown(key, reply)) => {
                if host_key_mode == SshHostKeyVerificationMode::AutoAccept {
                    let _ = reply.send(true);
                    continue;
                }
                let _ = reply.send(false);
                return Err(SftpError::Conflict(body(format!(
                    "The target's host key ({}) is not trusted yet. Open the SSH terminal once to verify it.",
                    sha256_fingerprint(&key)
                ))));
            }
            Some(RCEvent::ConnectionError(err)) => {
                warn!(%err, "SFTP connection failed");
                let msg = connection_error_message(&err);
                return Err(
                    if matches!(
                        err,
                        gated_protocol_ssh::ConnectionError::HostKeyMismatch { .. }
                    ) {
                        SftpError::Conflict(body(msg))
                    } else {
                        SftpError::bad_gateway(msg)
                    },
                );
            }
            Some(RCEvent::Error(err)) => {
                warn!(%err, "SFTP connection error");
                return Err(SftpError::bad_gateway("SSH connection error"));
            }
            None => return Err(SftpError::bad_gateway("SSH connection closed unexpectedly")),
            Some(_) => {}
        }
    }

    let channel = Uuid::new_v4();
    send_and_wait(
        handles,
        RCCommand::Channel(channel, ChannelOperation::OpenShell),
    )
    .await?;
    send_and_wait(
        handles,
        RCCommand::Channel(channel, ChannelOperation::RequestSubsystem("sftp".into())),
    )
    .await?;
    Ok(channel)
}

/// Moves bytes between the SSH channel and the SFTP client until the channel
/// closes, the connection idles out or the session is closed.
#[allow(
    clippy::too_many_arguments,
    reason = "owns every per-connection resource"
)]
async fn pump(
    mut handles: gated_protocol_ssh::RemoteClientHandles,
    channel: Uuid,
    local: tokio::io::DuplexStream,
    close: Arc<Notify>,
    last_used: Arc<std::sync::Mutex<Instant>>,
    key: ConnectionKey,
    session_id: SessionId,
    session_handle: Arc<Mutex<gated_core::GatedServerHandle>>,
) {
    let (mut reader, mut writer) = tokio::io::split(local);
    let mut buf = vec![0u8; IO_CHUNK];
    let mut idle_check = tokio::time::interval(Duration::from_secs(30));
    let touch = || {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut last = last_used.lock().unwrap();
        *last = Instant::now();
    };
    session_handle.lock().await.audit_target_connected().await;

    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    touch();
                    let data = Bytes::copy_from_slice(buf.get(..n).unwrap_or_default());
                    if handles
                        .command_tx
                        .send((RCCommand::Channel(channel, ChannelOperation::Data(data)), None))
                        .is_err()
                    {
                        break;
                    }
                }
            },
            event = handles.event_rx.recv() => match event {
                Some(RCEvent::Output(c, data)) if c == channel => {
                    touch();
                    if writer.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(RCEvent::Eof(c) | RCEvent::Close(c)) if c == channel => break,
                Some(RCEvent::Error(_)) | None => break,
                Some(_) => {}
            },
            () = close.notified() => break,
            _ = idle_check.tick() => {
                #[allow(clippy::unwrap_used, reason = "panic on poison")]
                let idle = last_used.lock().unwrap().elapsed();
                if idle >= IDLE_TIMEOUT {
                    break;
                }
            }
        }
    }

    let _ = handles.command_tx.send((RCCommand::Disconnect, None));
    let _ = handles.abort_tx.send(());
    drop_connection(&key, session_id).await;
    info!(%session_id, "web_sftp_session_ended");
    drop(session_handle);
}

// --- audit ---------------------------------------------------------------

struct Audit<'a> {
    operation: &'static str,
    path: &'a str,
    new_path: Option<&'a str>,
    bytes: Option<u64>,
    error: Option<String>,
}

async fn record(services: &Services, conn: &SftpConnection, audit: Audit<'_>) {
    let item = FileAuditRecordingItem::Operation {
        timestamp: chrono::Utc::now(),
        target: conn.target.name.clone(),
        target_id: Some(conn.target.id),
        user_id: Some(conn.user.id),
        username: Some(conn.user.username.clone()),
        origin: "web".into(),
        operation: audit.operation.into(),
        path: audit.path.into(),
        new_path: audit.new_path.map(Into::into),
        bytes: audit.bytes,
        success: audit.error.is_none(),
        error: audit.error,
    };
    let metadata = FileAuditSessionMetadata::WebFileSession {
        target: conn.target.name.clone(),
        target_id: Some(conn.target.id),
    };
    let mut recordings = services.recordings.lock().await;
    match recordings
        .start::<FileAuditRecorder, _>(&conn.session_id, Some("web-files".into()), metadata)
        .await
    {
        Ok(mut recorder) => {
            if let Err(err) = recorder.write_item(&item).await {
                debug!(%err, "Failed to append file audit item");
            }
        }
        Err(gated_core::recordings::Error::Disabled) => {}
        Err(err) => debug!(%err, "File audit recording not available"),
    }
}

/// Run an SFTP call, dropping the connection on a transport failure.
async fn call<T>(
    conn: &SftpConnection,
    result: Result<T, SftpClientError>,
) -> Result<T, SftpError> {
    result.map_err(|err| {
        if is_transport_error(&err) {
            conn.close.notify_one();
        }
        map_sftp_error(&err)
    })
}

// --- handlers ------------------------------------------------------------

#[derive(Serialize, ToSchema)]
pub struct SftpEntry {
    name: String,
    /// `"dir"` | `"file"` | `"symlink"` | `"other"`.
    kind: String,
    size: Option<u64>,
    /// Unix mode bits.
    permissions: Option<u32>,
    /// Modification time, seconds since the Unix epoch.
    mtime: Option<u32>,
    user: Option<String>,
    group: Option<String>,
    uid: Option<u32>,
    gid: Option<u32>,
}

#[derive(Serialize, ToSchema)]
pub struct SftpListing {
    /// Canonical absolute path of the listed directory.
    path: String,
    entries: Vec<SftpEntry>,
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PathQuery {
    /// Defaults to the login directory.
    path: Option<String>,
}

api_response! {
    enum ListResponse {
        #[oai(status = 200)]
        Ok(Json<SftpListing>),
    }
}

#[utoipa::path(
    get,
    path = "/sftp/{target_name}/list",
    operation_id = "sftp_list",
    params(PathQuery)
)]
async fn api_sftp_list(
    target_name: Path<String>,
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    _sec_scheme: AnySecurityScheme,
    Query(query): Query<PathQuery>,
) -> Result<ListResponse, SftpError> {
    let conn = connection(&services, &auth, &target_name).await?;
    let requested = query.path.unwrap_or_else(|| ".".into());
    validate_path(&requested)?;
    let path = call(&conn, conn.sftp.canonicalize(requested).await).await?;
    let mut entries: Vec<SftpEntry> = call(&conn, conn.sftp.read_dir(path.clone()).await)
        .await?
        .map(|entry| {
            let meta = entry.metadata();
            SftpEntry {
                name: entry.file_name(),
                kind: match entry.file_type() {
                    FileType::Dir => "dir",
                    FileType::File => "file",
                    FileType::Symlink => "symlink",
                    FileType::Other => "other",
                }
                .into(),
                size: meta.size,
                permissions: meta.permissions,
                mtime: meta.mtime,
                user: meta.user,
                group: meta.group,
                uid: meta.uid,
                gid: meta.gid,
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
    entries.sort_by(|a, b| {
        (a.kind != "dir", a.name.to_lowercase()).cmp(&(b.kind != "dir", b.name.to_lowercase()))
    });
    Ok(ListResponse::Ok(Json(SftpListing { path, entries })))
}

#[derive(Deserialize, ToSchema)]
struct MkdirRequest {
    path: String,
}

#[derive(Deserialize, ToSchema)]
struct RenameRequest {
    from: String,
    to: String,
}

#[derive(Deserialize, ToSchema)]
struct RemoveRequest {
    path: String,
    /// Remove an empty directory instead of a file.
    #[serde(default)]
    directory: bool,
}

api_response! {
    enum OkResponse {
        #[oai(status = 204)]
        Done,
    }
}

async fn audited(
    services: &Services,
    conn: &SftpConnection,
    operation: &'static str,
    path: &str,
    new_path: Option<&str>,
    result: Result<(), SftpClientError>,
) -> Result<OkResponse, SftpError> {
    let result = call(conn, result).await;
    record(
        services,
        conn,
        Audit {
            operation,
            path,
            new_path,
            bytes: None,
            error: result.as_ref().err().map(SftpError::message),
        },
    )
    .await;
    result.map(|()| OkResponse::Done)
}

#[utoipa::path(post, path = "/sftp/{target_name}/mkdir", operation_id = "sftp_mkdir")]
async fn api_sftp_mkdir(
    target_name: Path<String>,
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    _sec_scheme: AnySecurityScheme,
    body: Json<MkdirRequest>,
) -> Result<OkResponse, SftpError> {
    validate_path(&body.path)?;
    let conn = connection(&services, &auth, &target_name).await?;
    let result = conn.sftp.create_dir(body.path.clone()).await;
    audited(&services, &conn, "mkdir", &body.path, None, result).await
}

#[utoipa::path(
    post,
    path = "/sftp/{target_name}/rename",
    operation_id = "sftp_rename"
)]
async fn api_sftp_rename(
    target_name: Path<String>,
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    _sec_scheme: AnySecurityScheme,
    body: Json<RenameRequest>,
) -> Result<OkResponse, SftpError> {
    validate_path(&body.from)?;
    validate_path(&body.to)?;
    let conn = connection(&services, &auth, &target_name).await?;
    let result = conn.sftp.rename(body.from.clone(), body.to.clone()).await;
    audited(
        &services,
        &conn,
        "rename",
        &body.from,
        Some(&body.to),
        result,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/sftp/{target_name}/remove",
    operation_id = "sftp_remove"
)]
async fn api_sftp_remove(
    target_name: Path<String>,
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    _sec_scheme: AnySecurityScheme,
    body: Json<RemoveRequest>,
) -> Result<OkResponse, SftpError> {
    validate_path(&body.path)?;
    let conn = connection(&services, &auth, &target_name).await?;
    let (operation, result) = if body.directory {
        ("rmdir", conn.sftp.remove_dir(body.path.clone()).await)
    } else {
        ("remove", conn.sftp.remove_file(body.path.clone()).await)
    };
    audited(&services, &conn, operation, &body.path, None, result).await
}

fn file_name(path: &str) -> &str {
    path.rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("download")
}

/// `attachment` disposition with an RFC 5987 encoded file name.
fn content_disposition(name: &str) -> HeaderValue {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// Streams a file to the browser; the read is audited when the transfer ends.
pub async fn api_sftp_download(
    target_name: Path<String>,
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    Query(query): Query<PathQuery>,
) -> Response {
    match download(&services, &auth, &target_name, query.path).await {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

async fn download(
    services: &Services,
    auth: &RequestAuthorization,
    target_name: &str,
    path: Option<String>,
) -> Result<Response, SftpError> {
    let path = path.ok_or_else(|| SftpError::BadRequest(body("path is required")))?;
    validate_path(&path)?;
    let conn = connection(services, auth, target_name).await?;
    let mut file = match call(&conn, conn.sftp.open(path.clone()).await).await {
        Ok(file) => file,
        Err(err) => {
            record(
                services,
                &conn,
                Audit {
                    operation: "read",
                    path: &path,
                    new_path: None,
                    bytes: Some(0),
                    error: Some(err.message()),
                },
            )
            .await;
            return Err(err);
        }
    };
    let size = file.metadata().await.ok().and_then(|m| m.size);
    let disposition = content_disposition(file_name(&path));

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    let services = services.clone();
    tokio::spawn(async move {
        let mut total = 0u64;
        let mut buf = vec![0u8; IO_CHUNK];
        let error = loop {
            match file.read(&mut buf).await {
                Ok(0) => break None,
                Ok(n) => {
                    conn.touch();
                    total += n as u64;
                    let chunk = Bytes::copy_from_slice(buf.get(..n).unwrap_or_default());
                    if tx.send(Ok(chunk)).await.is_err() {
                        break Some("download cancelled by the client".to_string());
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    break Some(e.to_string());
                }
            }
        };
        let _ = file.shutdown().await;
        record(
            &services,
            &conn,
            Audit {
                operation: "read",
                path: &path,
                new_path: None,
                bytes: Some(total),
                error,
            },
        )
        .await;
    });

    let stream = tokio_stream_from(rx);
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_DISPOSITION, disposition);
    if let Some(size) = size
        && let Ok(value) = HeaderValue::from_str(&size.to_string())
    {
        headers.insert(header::CONTENT_LENGTH, value);
    }
    Ok(response)
}

fn tokio_stream_from(
    mut rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> {
    futures::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

#[derive(Deserialize)]
pub struct UploadQuery {
    path: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

/// Streams the request body into a file on the target; audited as a write.
pub async fn api_sftp_upload(
    target_name: Path<String>,
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    request_body: Body,
) -> Response {
    match upload(
        &services,
        &auth,
        &target_name,
        query,
        &headers,
        request_body,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => err.into_response(),
    }
}

async fn upload(
    services: &Services,
    auth: &RequestAuthorization,
    target_name: &str,
    query: UploadQuery,
    headers: &HeaderMap,
    request_body: Body,
) -> Result<(), SftpError> {
    let path = query
        .path
        .ok_or_else(|| SftpError::BadRequest(body("path is required")))?;
    validate_path(&path)?;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|len| len > MAX_UPLOAD_BYTES) {
        return Err(SftpError::PayloadTooLarge(body(
            "Upload exceeds the size limit",
        )));
    }
    let conn = connection(services, auth, target_name).await?;
    if !query.overwrite && call(&conn, conn.sftp.try_exists(path.clone()).await).await? {
        return Err(SftpError::Conflict(body(
            "A file with this name already exists",
        )));
    }

    let mut total = 0u64;
    let result = async {
        let mut file = call(&conn, conn.sftp.create(path.clone()).await).await?;
        let mut stream = request_body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| SftpError::BadRequest(body(format!("Upload interrupted: {e}"))))?;
            total += chunk.len() as u64;
            if total > MAX_UPLOAD_BYTES {
                return Err(SftpError::PayloadTooLarge(body(
                    "Upload exceeds the size limit",
                )));
            }
            conn.touch();
            file.write_all(&chunk)
                .await
                .map_err(|e| SftpError::bad_gateway(format!("Write failed: {e}")))?;
        }
        file.shutdown()
            .await
            .map_err(|e| SftpError::bad_gateway(format!("Write failed: {e}")))
    }
    .await;

    record(
        services,
        &conn,
        Audit {
            operation: "write",
            path: &path,
            new_path: None,
            bytes: Some(total),
            error: result.as_ref().err().map(SftpError::message),
        },
    )
    .await;
    result
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_sftp_list,
        api_sftp_mkdir,
        api_sftp_rename,
        api_sftp_remove,
    )
    .route_layer(from_fn(require_auth))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_is_the_last_path_segment() {
        assert_eq!(file_name("/var/log/syslog"), "syslog");
        assert_eq!(file_name("/var/log/"), "log");
        assert_eq!(file_name("/"), "download");
    }

    #[test]
    fn content_disposition_encodes_non_ascii_names() {
        let value = content_disposition("报告 \"v1\".txt");
        let value = value.to_str().unwrap();
        assert!(value.starts_with("attachment; filename=\"__"), "{value}");
        assert!(
            value.contains("filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%22v1%22.txt"),
            "{value}"
        );
    }

    #[test]
    fn status_errors_map_to_http_statuses() {
        let status = |code| {
            SftpClientError::Status(russh_sftp::protocol::Status {
                id: 1,
                status_code: code,
                error_message: "boom".into(),
                language_tag: "en".into(),
            })
        };
        assert!(matches!(
            map_sftp_error(&status(SftpStatusCode::NoSuchFile)),
            SftpError::NotFound(_)
        ));
        assert!(matches!(
            map_sftp_error(&status(SftpStatusCode::PermissionDenied)),
            SftpError::Forbidden(_)
        ));
        assert!(matches!(
            map_sftp_error(&status(SftpStatusCode::Failure)),
            SftpError::BadRequest(_)
        ));
        assert!(matches!(
            map_sftp_error(&SftpClientError::Timeout),
            SftpError::BadGateway(_)
        ));
        assert!(!is_transport_error(&status(SftpStatusCode::Failure)));
        assert!(is_transport_error(&SftpClientError::Timeout));
    }

    #[test]
    fn paths_must_be_non_empty_without_nul() {
        assert!(validate_path("/tmp").is_ok());
        assert!(validate_path("").is_err());
        assert!(validate_path("/tmp/\0x").is_err());
    }
}
