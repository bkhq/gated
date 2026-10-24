//! One-off TLS handshake against an upstream to report the certificate chain
//! it presents and whether the gateway would trust it.

use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme};
use rustls_pki_types::pem::PemObject;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use super::{ROOT_CERT_STORE, RustlsSetupError};

#[derive(Debug, Clone)]
pub struct PeerChain {
    /// DER certificates, leaf first.
    pub certificates: Vec<Vec<u8>>,
    /// Why the chain fails verification against the trusted roots (including
    /// the optional extra CA bundle); `None` when it verifies.
    pub verify_error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum InspectError {
    #[error(transparent)]
    Setup(#[from] RustlsSetupError),
    #[error("invalid server name: {0}")]
    ServerName(String),
    #[error("connection timed out")]
    Timeout,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("the upstream presented no certificate")]
    NoCertificate,
}

/// Records the presented chain and the real verifier's verdict, then accepts
/// the handshake so an untrusted chain can still be shown.
#[derive(Debug)]
struct RecordingVerifier {
    inner: Arc<WebPkiServerVerifier>,
    seen: Mutex<Option<PeerChain>>,
}

impl ServerCertVerifier for RecordingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let verify_error = self
            .inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            .err()
            .map(|error| error.to_string());
        let certificates = std::iter::once(end_entity)
            .chain(intermediates)
            .map(|cert| cert.as_ref().to_vec())
            .collect();
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(PeerChain {
                certificates,
                verify_error,
            });
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Connects to `host:port`, completes a TLS handshake and returns the chain
/// the upstream presented. `root_cert` is an extra PEM CA bundle trusted on
/// top of the system roots, as for the HTTP proxy.
pub async fn inspect_peer_chain(
    host: &str,
    port: u16,
    root_cert: Option<&[u8]>,
    timeout: Duration,
) -> Result<PeerChain, InspectError> {
    let mut cert_store = ROOT_CERT_STORE.clone();
    if let Some(data) = root_cert {
        for cert in CertificateDer::pem_reader_iter(&mut Cursor::new(data)) {
            cert_store
                .add(cert.map_err(RustlsSetupError::from)?)
                .map_err(RustlsSetupError::from)?;
        }
    }
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(cert_store), provider.clone())
        .build()
        .map_err(RustlsSetupError::from)?;
    let verifier = Arc::new(RecordingVerifier {
        inner,
        seen: Mutex::new(None),
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(RustlsSetupError::from)?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();

    let server_name = ServerName::try_from(host.to_owned())
        .map_err(|_| InspectError::ServerName(host.to_owned()))?;
    let handshake = async {
        let stream = TcpStream::connect((host, port)).await?;
        TlsConnector::from(Arc::new(config))
            .connect(server_name, stream)
            .await
    };
    tokio::time::timeout(timeout, handshake)
        .await
        .map_err(|_| InspectError::Timeout)??;

    verifier
        .seen
        .lock()
        .ok()
        .and_then(|mut seen| seen.take())
        .ok_or(InspectError::NoCertificate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::PrivateKeyDer;
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;

    async fn serve_self_signed() -> (u16, String) {
        let key = rcgen::KeyPair::generate().expect("key");
        let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
            .expect("params")
            .self_signed(&key)
            .expect("cert");
        let pem = cert.pem();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivateKeyDer::try_from(key.serialize_der()).expect("key der"),
        )
        .expect("server config");
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let _ = acceptor.accept(stream).await;
            }
        });
        (port, pem)
    }

    #[tokio::test]
    async fn reports_an_untrusted_chain_and_trusts_it_with_its_ca() {
        let (port, pem) = serve_self_signed().await;

        let untrusted = inspect_peer_chain("localhost", port, None, Duration::from_secs(5))
            .await
            .expect("inspect");
        assert_eq!(untrusted.certificates.len(), 1);
        assert!(untrusted.verify_error.is_some());

        let trusted = inspect_peer_chain(
            "localhost",
            port,
            Some(pem.as_bytes()),
            Duration::from_secs(5),
        )
        .await
        .expect("inspect");
        assert_eq!(trusted.verify_error, None);
    }
}
