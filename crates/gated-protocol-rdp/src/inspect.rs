//! The certificate an RDP target presents, without logging on.

use std::io;
use std::time::Duration;

use gated_tls::{InspectError, PeerChain, inspect_peer_chain_over};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// X.224 Connection Request with an RDP negotiation request for TLS or
/// TLS with network level authentication (MS-RDPBCGR 2.2.1.1). TLS starts
/// the same way under both.
const CONNECTION_REQUEST: [u8; 19] = [
    0x03, 0x00, 0x00, 0x13, // TPKT: version 3, 19 bytes
    0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 connection request
    0x01, 0x00, 0x08, 0x00, // negotiation request, 8 bytes
    0x03, 0x00, 0x00, 0x00, // PROTOCOL_SSL | PROTOCOL_HYBRID
];

const X224_CONNECTION_CONFIRM: u8 = 0xd0;
const NEGOTIATION_RESPONSE: u8 = 0x02;

/// The longest connection confirm accepted; a real one is 19 bytes.
const MAX_CONFIRM_BYTES: usize = 64;

fn refused(reason: &'static str) -> InspectError {
    InspectError::Io(io::Error::new(io::ErrorKind::InvalidData, reason))
}

/// Whether a connection confirm (without its TPKT header) selects TLS.
fn selects_tls(confirm: &[u8]) -> bool {
    let is_confirm = confirm
        .get(1)
        .is_some_and(|code| code & 0xf0 == X224_CONNECTION_CONFIRM);
    let is_response = confirm.get(7) == Some(&NEGOTIATION_RESPONSE);
    let selected = confirm
        .get(11..15)
        .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
        .map(u32::from_le_bytes);
    is_confirm && is_response && selected.is_some_and(|protocol| protocol != 0)
}

/// Connects to an RDP target, negotiates TLS and returns the certificate
/// chain it presents with the verdict of the system roots. Nothing is sent
/// after the handshake: no credentials leave the gateway.
pub async fn inspect_certificate(
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<PeerChain, InspectError> {
    let inspect = async {
        let mut stream = TcpStream::connect((host, port)).await?;
        stream.write_all(&CONNECTION_REQUEST).await?;

        let mut header = [0u8; 4];
        stream.read_exact(&mut header).await?;
        let [version, _, length_high, length_low] = header;
        let length = usize::from(u16::from_be_bytes([length_high, length_low]));
        if version != 3 || !(header.len()..=MAX_CONFIRM_BYTES).contains(&length) {
            return Err(refused("the target did not answer as an RDP server"));
        }
        let mut confirm = vec![0u8; length - header.len()];
        stream.read_exact(&mut confirm).await?;
        if !selects_tls(&confirm) {
            return Err(refused("the target did not offer TLS"));
        }

        inspect_peer_chain_over(stream, host, None).await
    };
    tokio::time::timeout(timeout, inspect)
        .await
        .map_err(|_| InspectError::Timeout)?
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]
mod tests {
    use std::sync::Arc;

    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;
    use tokio_rustls::rustls::ServerConfig;
    use tokio_rustls::rustls::pki_types::PrivateKeyDer;

    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

    /// A server that answers the connection request with `confirm` and then
    /// serves TLS with a self-signed certificate.
    async fn serve(confirm: &'static [u8]) -> u16 {
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let config = ServerConfig::builder_with_provider(Arc::new(
            tokio_rustls::rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivateKeyDer::try_from(key.serialize_der()).unwrap(),
        )
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 19];
            stream.read_exact(&mut request).await.unwrap();
            assert_eq!(request, CONNECTION_REQUEST);
            stream.write_all(confirm).await.unwrap();
            let _ = acceptor.accept(stream).await;
        });
        port
    }

    #[tokio::test]
    async fn reports_the_chain_of_a_target_that_selects_tls() {
        // Connection confirm selecting PROTOCOL_HYBRID.
        let port = serve(&[
            0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, 0x02, 0x1f, 0x08,
            0x00, 0x02, 0x00, 0x00, 0x00,
        ])
        .await;
        let chain = inspect_certificate("localhost", port, TIMEOUT)
            .await
            .unwrap();
        assert_eq!(chain.certificates.len(), 1);
        // Self-signed: shown, and reported as not trusted.
        assert!(chain.verify_error.is_some());
    }

    #[tokio::test]
    async fn a_target_that_refuses_tls_is_an_error() {
        // Negotiation failure: SSL_NOT_ALLOWED_BY_SERVER.
        let port = serve(&[
            0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, 0x03, 0x00, 0x08,
            0x00, 0x02, 0x00, 0x00, 0x00,
        ])
        .await;
        let error = inspect_certificate("localhost", port, TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "the target did not offer TLS");
    }

    #[tokio::test]
    async fn a_confirm_without_negotiation_data_means_no_tls() {
        // A server with plain RDP security only answers without the block.
        let port = serve(&[
            0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00,
        ])
        .await;
        let error = inspect_certificate("localhost", port, TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "the target did not offer TLS");
    }

    #[tokio::test]
    async fn something_that_is_not_rdp_is_an_error() {
        let port = serve(b"SSH-2.0-not-rdp\r\n").await;
        let error = inspect_certificate("localhost", port, TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "the target did not answer as an RDP server"
        );
    }
}
