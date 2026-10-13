use std::sync::Arc;

use anyhow::{Context, bail};
use futures::StreamExt;
use gated_common::helpers::websocket::pump_websocket;
use gated_common::{SessionId, TargetHttpOptions};
use gated_core::Services;
use gated_core::recordings::{SessionRecordings, TerminalRecorder, TerminalRecordingStreamId};
use poem::web::websocket::{WebSocket, WebSocketStream};
use poem::{IntoResponse, Request};
use reqwest_websocket::Upgrade;
use serde::Deserialize;
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite;
use tracing::*;

use crate::engine::{FlavorHook, construct_target_url};

use super::recording::{deduce_exec_recording_metadata, start_recording_exec};

async fn run_websocket_recording(mut recorder: TerminalRecorder, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(data) = rx.recv().await {
        let Some((&msg_type, rest)) = data.split_first() else {
            continue;
        };
        let data = rest.to_vec();

        let result = match msg_type {
            0..2 => {
                recorder
                    .write(
                        TerminalRecordingStreamId::from_usual_fd_number(msg_type)
                            .unwrap_or_default(),
                        &data,
                    )
                    .await
            }
            4 => {
                #[derive(Deserialize)]
                struct ResizeData {
                    #[serde(rename = "Width")]
                    width: u32,
                    #[serde(rename = "Height")]
                    height: u32,
                }
                if let Ok(resize_data) = serde_json::from_slice::<ResizeData>(&data) {
                    recorder
                        .write_pty_resize(resize_data.width, resize_data.height)
                        .await
                } else {
                    continue;
                }
            }
            _ => continue,
        };
        if let Err(e) = result {
            error!("Failed to write recording item: {}", e);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn handle_websocket_request(
    ws: WebSocket,
    req: &Request,
    options: &TargetHttpOptions,
    path: &str,
    session_id: SessionId,
    services: &Services,
    recordings: &Arc<Mutex<SessionRecordings>>,
) -> anyhow::Result<impl IntoResponse + use<>> {
    let mut full_url = construct_target_url(req, path, &options.url, FlavorHook::Kubernetes)?;
    if full_url.scheme() == "https" {
        let _ = full_url.set_scheme("wss");
    } else {
        let _ = full_url.set_scheme("ws");
    }

    // channel.k8s.io requires HTTP/1.1 — use a dedicated client builder
    // (the shared `build_http_client` permits HTTP/2 negotiation).
    let client = build_websocket_client(options)?;

    let (recorder_tx, recorder_rx) = mpsc::channel::<Vec<u8>>(1000);
    {
        let enabled = {
            let config = services.config.read().await;
            config.store.recordings.enable
        };
        if enabled {
            match start_recording_exec(
                &session_id,
                recordings,
                deduce_exec_recording_metadata(&full_url),
            )
            .await
            {
                Err(e) => {
                    error!("Failed to start recording: {}", e);
                }
                Ok(recorder) => {
                    tokio::spawn(run_websocket_recording(recorder, recorder_rx));
                }
            }
        }
    };

    let ws_protocol = req
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|h| h.to_str().ok())
        .context("missing Sec-Websocket-Protocol request header")?
        .to_string();

    let ws_handler_inner = async move |socket: WebSocketStream| {
        let client_response = client
            .get(full_url.clone())
            .upgrade()
            .protocols(vec![ws_protocol])
            .send()
            .await
            .context("sending websocket request to Kubernetes API")?;

        let status = client_response.status();
        if status != http::StatusCode::SWITCHING_PROTOCOLS {
            let client_response = client_response.into_inner();
            let body = client_response.text().await?;
            bail!("Unexpected websocket response status from Kubernetes API: {status}: {body}");
        }

        let client_socket = client_response
            .into_websocket()
            .await
            .context("negotiating websocket connection with Kubernetes")?;

        let (client_sink, client_source) = client_socket.split();

        let (server_sink, server_source) = socket.split();
        let server_to_client = {
            let recorder_tx = recorder_tx.clone();
            tokio::spawn(pump_websocket(server_source, client_sink, move |msg| {
                let recorder_tx = recorder_tx.clone();
                async move {
                    tracing::debug!("Server: {:?}", msg);
                    if let tungstenite::Message::Binary(data) = &msg {
                        let _ = recorder_tx.send(data.to_vec()).await;
                    }
                    anyhow::Ok(msg)
                }
            }))
        };

        let client_to_server =
            tokio::spawn(pump_websocket(client_source, server_sink, move |msg| {
                let recorder_tx = recorder_tx.clone();
                async move {
                    tracing::debug!("Client: {:?}", msg);
                    if let tungstenite::Message::Binary(data) = &msg {
                        let _ = recorder_tx.send(data.to_vec()).await;
                    }
                    anyhow::Ok(msg)
                }
            }));

        server_to_client.await??;
        client_to_server.await??;
        debug!("Closing Websocket stream");
        Ok::<(), anyhow::Error>(())
    };

    Ok(ws
        .protocols(vec![
            "channel.k8s.io",
            "v2.channel.k8s.io",
            "v3.channel.k8s.io",
            "v4.channel.k8s.io",
            "v5.channel.k8s.io",
        ])
        .on_upgrade(|socket| async move {
            ws_handler_inner(socket).await.inspect_err(|e| {
                error!("Websocket handling error: {e:?}");
            })?;
            Ok::<(), anyhow::Error>(())
        })
        .into_response())
}

/// Build a reqwest client constrained to HTTP/1.1, as required for
/// `channel.k8s.io` WebSocket upgrade negotiation.  Mirrors
/// [`build_http_client`] but with `.http1_only()` applied.
fn build_websocket_client(options: &TargetHttpOptions) -> anyhow::Result<reqwest::Client> {
    use anyhow::Context as _;
    use gated_common::UpstreamAuth;
    use gated_tls::TlsMode;
    use url::Url;
    use x509_parser::pem::Pem;

    let parsed_url = Url::parse(&options.url).context("parsing upstream URL")?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => anyhow::bail!(
            "unsupported upstream URL scheme '{}': only http and https are allowed",
            scheme
        ),
    }
    match options.tls.mode {
        TlsMode::Required if parsed_url.scheme() == "http" => {
            anyhow::bail!("tls.mode=required but URL is http://")
        }
        TlsMode::Disabled if parsed_url.scheme() == "https" => {
            anyhow::bail!("tls.mode=disabled but URL is https://")
        }
        _ => {}
    }

    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .http1_only();
    if !options.tls.verify {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if let Some(ca_pem) = &options.ca_certificate {
        let ca_pem = ca_pem.expose_secret();
        if !ca_pem.trim().is_empty() {
            for pem in Pem::iter_from_buffer(ca_pem.as_bytes()) {
                let pem = pem.context("parsing upstream CA PEM bundle")?;
                if pem.label != "CERTIFICATE" {
                    continue;
                }
                let certificate = reqwest::Certificate::from_der(&pem.contents)
                    .context("parsing upstream CA certificate")?;
                builder = builder.add_root_certificate(certificate);
            }
        }
    }
    match &options.upstream_auth {
        UpstreamAuth::None(_) => {}
        UpstreamAuth::Headers(auth) => {
            let mut h = reqwest::header::HeaderMap::new();
            for (name, value) in &auth.headers {
                h.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes())
                        .context("invalid injected header name")?,
                    reqwest::header::HeaderValue::from_str(value.expose_secret())
                        .context("invalid injected header value")?,
                );
            }
            builder = builder.default_headers(h);
        }
        UpstreamAuth::BearerToken(auth) => {
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!(
                    "Bearer {}",
                    auth.token.expose_secret()
                ))
                .context("setting Authorization header")?,
            );
            builder = builder.default_headers(h);
        }
        UpstreamAuth::ClientCertificate(auth) => {
            let cert_pem = auth.certificate.expose_secret();
            let key_pem = auth.private_key.expose_secret();
            let mut pem_bundle = String::new();
            pem_bundle.push_str(cert_pem);
            if !pem_bundle.ends_with('\n') {
                pem_bundle.push('\n');
            }
            pem_bundle.push_str(key_pem);
            if !pem_bundle.ends_with('\n') {
                pem_bundle.push('\n');
            }
            let identity = reqwest::Identity::from_pem(pem_bundle.as_bytes())
                .context("invalid upstream client certificate/private key")?;
            builder = builder.identity(identity);
        }
    }

    builder.build().context("building reqwest client")
}
