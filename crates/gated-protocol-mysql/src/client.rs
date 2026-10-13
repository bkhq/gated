use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use gated_common::TargetMySqlOptions;
use gated_database_protocols::io::Decode;
use gated_database_protocols::mysql::protocol::Capabilities;
use gated_database_protocols::mysql::protocol::auth::AuthPlugin;
use gated_database_protocols::mysql::protocol::connect::{
    AuthSwitchRequest, AuthSwitchResponse, Handshake, HandshakeResponse, SslRequest,
};
use gated_database_protocols::mysql::protocol::response::ErrPacket;
use gated_tls::{TlsMode, configure_tls_connector};
use rsa::pkcs8::DecodePublicKey;
use rsa::{Oaep, RsaPublicKey};
use tokio::net::TcpStream;
use tracing::*;

use crate::common::{
    compute_auth_challenge_response, compute_caching_sha2_response, xor_password_with_nonce,
};
use crate::error::MySqlError;
use crate::stream::MySqlStream;

pub struct MySqlClient {
    pub stream: MySqlStream<TcpStream, tokio_rustls::client::TlsStream<TcpStream>>,
    pub _capabilities: Capabilities,
}

pub struct ConnectionOptions {
    pub collation: u8,
    pub database: Option<String>,
    pub max_packet_size: u32,
    pub capabilities: Capabilities,
}

impl Default for ConnectionOptions {
    fn default() -> Self {
        ConnectionOptions {
            collation: 33,
            database: None,
            max_packet_size: 0xffff_ffff,
            capabilities: Capabilities::PROTOCOL_41
                | Capabilities::PLUGIN_AUTH
                | Capabilities::FOUND_ROWS
                | Capabilities::LONG_FLAG
                | Capabilities::NO_SCHEMA
                | Capabilities::PLUGIN_AUTH_LENENC_DATA
                | Capabilities::CONNECT_WITH_DB
                | Capabilities::SESSION_TRACK
                | Capabilities::IGNORE_SPACE
                | Capabilities::INTERACTIVE
                | Capabilities::TRANSACTIONS
                | Capabilities::DEPRECATE_EOF
                | Capabilities::SECURE_CONNECTION
                | Capabilities::SSL,
        }
    }
}

impl MySqlClient {
    pub async fn connect(
        target: &TargetMySqlOptions,
        mut options: ConnectionOptions,
    ) -> Result<Self, MySqlError> {
        let stream = TcpStream::connect((target.host.clone(), target.port)).await?;
        stream.set_nodelay(true)?;

        let mut stream = MySqlStream::new(stream);

        options.capabilities.remove(Capabilities::SSL);
        if target.tls.mode != TlsMode::Disabled {
            options.capabilities |= Capabilities::SSL;
        }

        let Some(payload) = stream.recv().await? else {
            return Err(MySqlError::Eof);
        };
        let handshake = Handshake::decode(payload)?;

        options.capabilities &= handshake.server_capabilities;
        if target.tls.mode == TlsMode::Required && !options.capabilities.contains(Capabilities::SSL)
        {
            return Err(MySqlError::TlsNotSupported);
        }

        info!(capabilities=?options.capabilities, "Target handshake");

        let tls_active = options.capabilities.contains(Capabilities::SSL)
            && target.tls.mode != TlsMode::Disabled;
        if tls_active {
            let accept_invalid_certs = !target.tls.verify;
            let accept_invalid_hostname = false; // ca + hostname verification
            let client_config = Arc::new(
                configure_tls_connector(accept_invalid_certs, accept_invalid_hostname, None)
                    .await?,
            );
            let req = SslRequest {
                collation: options.collation,
                max_packet_size: options.max_packet_size,
            };
            stream.push(&req, options.capabilities)?;
            stream.flush().await?;
            stream = stream
                .upgrade((
                    target
                        .host
                        .clone()
                        .try_into()
                        .map_err(|_| MySqlError::InvalidDomainName)?,
                    client_config,
                ))
                .await?;
            info!("Target connection upgraded to TLS");
        }

        let initial_nonce = {
            let mut n = Vec::with_capacity(
                handshake.auth_plugin_data.first_ref().len()
                    + handshake.auth_plugin_data.last_ref().len(),
            );
            n.extend_from_slice(handshake.auth_plugin_data.first_ref());
            n.extend_from_slice(handshake.auth_plugin_data.last_ref());
            // Some servers pad with a trailing NUL — the auth scramble uses only the first 20 bytes.
            while n.last() == Some(&0) && n.len() > 20 {
                n.pop();
            }
            n
        };

        let password = target.password.clone().unwrap_or_default();

        // When TLS was intended (`mode != Disabled`) but the link is plaintext
        // (server omitted the SSL capability under `Preferred`), refuse to send
        // the stored password in cleartext — a MITM could have stripped TLS to
        // force this downgrade. An empty password leaks nothing, so it is
        // allowed; `mode: disabled` opts into plaintext auth explicitly.
        if target.tls.mode != TlsMode::Disabled && !tls_active && !password.is_empty() {
            return Err(MySqlError::ProtocolError(
                "refusing to send credentials over a plaintext connection after TLS downgrade \
                 (set tls.mode = disabled to allow plaintext auth)"
                    .to_owned(),
            ));
        }

        let mut current_plugin = handshake.auth_plugin;
        let mut current_nonce = initial_nonce.clone();
        let initial_response = build_auth_response(current_plugin, &current_nonce, &password)?;

        let response = HandshakeResponse {
            auth_plugin: current_plugin,
            auth_response: initial_response
                .as_ref()
                .map(|b| BytesMut::from(&b[..]).freeze()),
            collation: options.collation,
            database: options.database,
            max_packet_size: options.max_packet_size,
            username: target.username.clone(),
        };
        stream.push(&response, options.capabilities)?;
        stream.flush().await?;

        // Authentication response loop: handles OK, Error, AuthSwitchRequest,
        // and caching_sha2_password's AuthMoreData (fast-auth / full-auth).
        loop {
            let Some(payload) = stream.recv().await? else {
                return Err(MySqlError::Eof);
            };
            match payload.first() {
                Some(&0x00) => {
                    debug!("Authorized");
                    break;
                }
                Some(&0xff) => {
                    let error = ErrPacket::decode_with(payload, options.capabilities)?;
                    return Err(MySqlError::ProtocolError(format!(
                        "handshake failed: {error:?}"
                    )));
                }
                Some(&0xfe) => {
                    // AuthSwitchRequest from server — a short packet (<= 1 byte)
                    // would instead be the legacy "old password" switch, which we don't support.
                    if payload.len() <= 1 {
                        return Err(MySqlError::ProtocolError(
                            "server requested legacy auth switch (not supported)".into(),
                        ));
                    }
                    let switch = AuthSwitchRequest::decode_with(payload, ())?;
                    debug!(plugin=?switch.plugin, "Auth switch request");
                    current_plugin = Some(switch.plugin);
                    current_nonce = switch.data.to_vec();
                    while current_nonce.last() == Some(&0) && current_nonce.len() > 20 {
                        current_nonce.pop();
                    }
                    let reply = build_auth_response(current_plugin, &current_nonce, &password)?
                        .unwrap_or_default();
                    stream.push(&AuthSwitchResponse(reply), options.capabilities)?;
                    stream.flush().await?;
                }
                Some(&0x01) => {
                    // caching_sha2_password AuthMoreData
                    handle_caching_sha2_more_data(
                        &mut stream,
                        &payload,
                        &current_nonce,
                        &password,
                        options.capabilities,
                    )
                    .await?;
                }
                other => {
                    return Err(MySqlError::ProtocolError(format!(
                        "unknown response type {:?}",
                        other
                    )));
                }
            }
        }

        stream.reset_sequence_id();

        Ok(Self {
            stream,
            _capabilities: options.capabilities,
        })
    }
}

/// Encode the upstream handshake response for the given auth plugin.
/// Returns `None` for an unknown plugin (let the server AuthSwitch us).
fn build_auth_response(
    plugin: Option<AuthPlugin>,
    nonce: &[u8],
    password: &str,
) -> Result<Option<Vec<u8>>, MySqlError> {
    match plugin {
        Some(AuthPlugin::MySqlNativePassword) => {
            if password.is_empty() {
                return Ok(Some(Vec::new()));
            }
            let scramble: [u8; 20] = nonce
                .get(..20)
                .ok_or_else(|| MySqlError::ProtocolError("nonce too short".into()))?
                .try_into()
                .map_err(|_| MySqlError::ProtocolError("nonce not 20 bytes".into()))?;
            let out =
                compute_auth_challenge_response(scramble, password).map_err(MySqlError::other)?;
            Ok(Some(out.as_bytes().to_vec()))
        }
        Some(AuthPlugin::CachingSha2Password) => {
            if password.is_empty() {
                return Ok(Some(Vec::new()));
            }
            let scramble: [u8; 20] = nonce
                .get(..20)
                .ok_or_else(|| MySqlError::ProtocolError("nonce too short".into()))?
                .try_into()
                .map_err(|_| MySqlError::ProtocolError("nonce not 20 bytes".into()))?;
            Ok(Some(
                compute_caching_sha2_response(&scramble, password).to_vec(),
            ))
        }
        Some(AuthPlugin::MySqlClearPassword) => {
            let mut out = password.as_bytes().to_vec();
            out.push(0);
            Ok(Some(out))
        }
        Some(AuthPlugin::Sha256Password) => {
            // Only supported over TLS or with an empty password — otherwise the RSA
            // exchange requires a pre-shared public key we don't have.
            if password.is_empty() {
                Ok(Some(vec![0]))
            } else {
                Ok(None)
            }
        }
        None => Ok(None),
    }
}

/// Handle a caching_sha2_password `AuthMoreData` packet (0x01 prefix).
///
/// Possible continuations:
///   `01 03`    — fast auth success (cached); next packet will be OK
///   `01 04`    — full auth required; we request or receive the server public key
///                and send an RSA-OAEP(SHA-1) encrypted XOR(password||NUL, nonce)
///   `01 <pem>` — public key reply to our `02` request
async fn handle_caching_sha2_more_data<S, TS>(
    stream: &mut MySqlStream<S, TS>,
    payload: &Bytes,
    nonce: &[u8],
    password: &str,
    capabilities: Capabilities,
) -> Result<(), MySqlError>
where
    S: gated_tls::UpgradableStream<TS>,
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    TS: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let rest = payload.get(1..).unwrap_or(&[]);
    match rest.first() {
        Some(&0x03) => {
            // fast_auth_success: the next packet will be OK / Error; nothing to send.
            trace!("caching_sha2_password: fast auth success");
            Ok(())
        }
        Some(&0x04) if rest.len() == 1 => {
            // full_auth required. If the current connection is secure, send
            // cleartext + NUL. Otherwise ask the server for its public key so we
            // can RSA-encrypt the password.
            if password.is_empty() {
                stream.push(&AuthSwitchResponse(vec![0]), capabilities)?;
                stream.flush().await?;
                return Ok(());
            }
            if stream.is_tls() {
                let mut out = password.as_bytes().to_vec();
                out.push(0);
                stream.push(&AuthSwitchResponse(out), capabilities)?;
                stream.flush().await?;
            } else {
                // Request public key.
                stream.push(&AuthSwitchResponse(vec![0x02]), capabilities)?;
                stream.flush().await?;
                let Some(key_payload) = stream.recv().await? else {
                    return Err(MySqlError::Eof);
                };
                if key_payload.first() != Some(&0x01) {
                    return Err(MySqlError::ProtocolError(format!(
                        "expected AuthMoreData with public key, got {:?}",
                        key_payload.first()
                    )));
                }
                let pem_bytes = key_payload.get(1..).unwrap_or(&[]);
                let cipher = rsa_encrypt_password(pem_bytes, password, nonce)?;
                stream.push(&AuthSwitchResponse(cipher), capabilities)?;
                stream.flush().await?;
            }
            Ok(())
        }
        _ => {
            // Unexpected payload following AuthMoreData. Some MySQL versions send
            // the RSA public key here directly, without us asking — detect a PEM.
            if rest.starts_with(b"-----BEGIN") {
                let cipher = rsa_encrypt_password(rest, password, nonce)?;
                stream.push(&AuthSwitchResponse(cipher), capabilities)?;
                stream.flush().await?;
                Ok(())
            } else {
                Err(MySqlError::ProtocolError(format!(
                    "unexpected AuthMoreData payload: {:?}",
                    rest
                )))
            }
        }
    }
}

/// RSA-OAEP(SHA-1) encrypt `XOR(password||NUL, nonce)` using the PEM-encoded
/// public key the server sent during caching_sha2_password full-auth.
/// Kept synchronous so its non-Send `ThreadRng` doesn't cross an await.
fn rsa_encrypt_password(
    pem_bytes: &[u8],
    password: &str,
    nonce: &[u8],
) -> Result<Vec<u8>, MySqlError> {
    let pem = std::str::from_utf8(pem_bytes)
        .map_err(|e| MySqlError::ProtocolError(format!("public key not utf-8: {e}")))?;
    let public_key = RsaPublicKey::from_public_key_pem(pem)
        .map_err(|e| MySqlError::ProtocolError(format!("invalid RSA public key: {e}")))?;
    let scrambled = xor_password_with_nonce(password, nonce);
    let mut rng = rand::thread_rng();
    public_key
        .encrypt(&mut rng, Oaep::new::<sha1::Sha1>(), &scrambled)
        .map_err(|e| MySqlError::ProtocolError(format!("RSA encrypt failed: {e}")))
}
