use std::net::SocketAddr;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use futures::StreamExt;
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use rustls::ServerConfig;
use rustls::pki_types::CertificateDer;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio_rustls::TlsAcceptor;
use tower_service::Service;
use tracing::*;

use crate::{GatedError, ListenEndpoint};

const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Facts about the connection a request arrived on, available as a request
/// extension.
#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub remote_addr: SocketAddr,
    pub tls: bool,
    /// End-entity certificate presented by the client during the handshake.
    pub peer_certificate: Option<CertificateDer<'static>>,
}

/// ALPN protocols a TLS listener must offer for HTTP/2 and HTTP/1.1.
pub fn alpn_protocols() -> Vec<Vec<u8>> {
    vec![b"h2".to_vec(), b"http/1.1".to_vec()]
}

/// Serves `app` on every address of `endpoint` until the future is dropped,
/// which also drops the open connections.
pub async fn serve(
    endpoint: &ListenEndpoint,
    tls: Option<Arc<ServerConfig>>,
    app: Router,
) -> Result<(), GatedError> {
    let mut incoming = pin!(endpoint.tcp_accept_stream().await?);
    let tls = tls.map(TlsAcceptor::from);
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            stream = incoming.next() => {
                let Some(stream) = stream else {
                    return Ok(());
                };
                match stream {
                    Ok(stream) => {
                        connections.spawn(serve_connection(stream, tls.clone(), app.clone()));
                    }
                    Err(error) => warn!(%error, "Failed to accept a connection"),
                }
            }
            Some(_) = connections.join_next() => {}
        }
    }
}

async fn serve_connection(stream: TcpStream, tls: Option<TlsAcceptor>, app: Router) {
    let Ok(remote_addr) = stream.peer_addr() else {
        return;
    };
    let _ = stream.set_nodelay(true);

    match tls {
        None => {
            let info = ConnectionInfo {
                remote_addr,
                tls: false,
                peer_certificate: None,
            };
            serve_io(stream, info, app).await;
        }
        Some(acceptor) => {
            let stream =
                match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                    Ok(Ok(stream)) => stream,
                    Ok(Err(error)) => {
                        debug!(%remote_addr, %error, "TLS handshake failed");
                        return;
                    }
                    Err(_) => {
                        debug!(%remote_addr, "TLS handshake timed out");
                        return;
                    }
                };
            let peer_certificate = stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|certificates| certificates.first())
                .map(|certificate| certificate.clone().into_owned());
            let info = ConnectionInfo {
                remote_addr,
                tls: true,
                peer_certificate,
            };
            serve_io(stream, info, app).await;
        }
    }
}

async fn serve_io<I>(io: I, info: ConnectionInfo, app: Router)
where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let remote_addr = info.remote_addr;
    let service = hyper::service::service_fn(move |mut request: Request<Incoming>| {
        request.extensions_mut().insert(info.clone());
        app.clone().call(request.map(Body::new))
    });
    if let Err(error) = Builder::new(TokioExecutor::new())
        .serve_connection_with_upgrades(TokioIo::new(io), service)
        .await
    {
        debug!(%remote_addr, %error, "Connection closed with an error");
    }
}

#[cfg(test)]
mod tests {
    use axum::Extension;
    use axum::routing::get;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn serves_requests_and_exposes_the_connection_info() {
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap().port()
        };
        let endpoint = ListenEndpoint::from(SocketAddr::from(([127, 0, 0, 1], port)));
        let app = Router::new().route(
            "/",
            get(|Extension(info): Extension<ConnectionInfo>| async move {
                format!(
                    "tls={} loopback={}",
                    info.tls,
                    info.remote_addr.ip().is_loopback()
                )
            }),
        );
        let server = tokio::spawn(async move { serve(&endpoint, None, app).await });

        let mut stream = loop {
            match TcpStream::connect(("127.0.0.1", port)).await {
                Ok(stream) => break stream,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        };
        stream
            .write_all(b"GET / HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();

        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with("tls=false loopback=true"), "{response}");
        server.abort();
    }
}
