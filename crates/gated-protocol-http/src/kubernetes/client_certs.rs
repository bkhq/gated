use std::sync::Arc;

use base64::{self, Engine};
use poem::Addr;
use poem::listener::Acceptor;
use poem::web::{LocalAddr, RemoteAddr};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::CertificateDer;
use rustls::server::WebPkiClientVerifier;
use rustls::server::danger::ClientCertVerifier;
use rustls::{RootCertStore, ServerConfig};
use tokio_rustls::server::TlsStream;
use tracing::{debug, warn};

/// Build a rustls client-certificate verifier providing real
/// proof-of-possession.
///
/// The returned verifier cryptographically validates that any presented
/// client certificate chains to the instance CA (chain + signature) *and*
/// that the TLS handshake `CertificateVerify` was produced by the private key
/// matching the end-entity certificate — both via rustls/webpki's real
/// verification, not the previous no-op `Ok(assertion())`. This defeats
/// replay of a known (public) certificate blob: an attacker without the
/// matching private key cannot complete the handshake.
///
/// `allow_unauthenticated` keeps mTLS optional so Bearer-token clients (which
/// present no certificate) still complete the handshake; any certificate that
/// *is* presented must be valid.
pub fn build_client_cert_verifier(
    ca_certificate_pem: &str,
    provider: Arc<CryptoProvider>,
) -> anyhow::Result<Arc<dyn ClientCertVerifier>> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(ca_certificate_pem.as_bytes())
        .map_err(|e| anyhow::anyhow!("parsing instance CA certificate PEM: {e}"))?;
    let ca_der = CertificateDer::from(pem.contents);

    let mut roots = RootCertStore::empty();
    roots
        .add(ca_der)
        .map_err(|e| anyhow::anyhow!("adding instance CA to client-auth trust store: {e}"))?;

    WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
        .allow_unauthenticated()
        .build()
        .map_err(|e| anyhow::anyhow!("building client certificate verifier: {e}"))
}

/// Custom TLS acceptor that captures client certificates and embeds them in remote_addr
pub struct CertificateCapturingAcceptor<T> {
    inner: T,
    tls_acceptor: tokio_rustls::TlsAcceptor,
}

impl<T> CertificateCapturingAcceptor<T> {
    pub fn new(inner: T, server_config: ServerConfig) -> Self {
        Self {
            inner,
            tls_acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(server_config)),
        }
    }
}

impl<T> Acceptor for CertificateCapturingAcceptor<T>
where
    T: Acceptor,
{
    type Io = TlsStream<T::Io>;

    fn local_addr(&self) -> Vec<LocalAddr> {
        self.inner.local_addr()
    }

    async fn accept(
        &mut self,
    ) -> std::io::Result<(Self::Io, LocalAddr, RemoteAddr, http::uri::Scheme)> {
        let (stream, local_addr, remote_addr, _) = self.inner.accept().await?;

        // Perform TLS handshake
        let tls_stream = self.tls_acceptor.accept(stream).await?;

        // Extract client certificate from the TLS connection
        let enhanced_remote_addr = if let Some(cert_der) = extract_peer_certificates(&tls_stream) {
            // Serialize certificate as base64 and embed in remote_addr
            let cert_b64 = base64::engine::general_purpose::STANDARD.encode(&cert_der);
            let original_remote_addr_str = match &remote_addr.0 {
                Addr::SocketAddr(addr) => addr.to_string(),
                Addr::Unix(_) => remote_addr.to_string(),
                Addr::Custom(_, _) => "".into(),
            };
            RemoteAddr(Addr::Custom(
                "captured-cert",
                format!("{original_remote_addr_str}|cert:{cert_b64}").into(),
            ))
        } else {
            remote_addr
        };

        Ok((
            tls_stream,
            local_addr,
            enhanced_remote_addr,
            http::uri::Scheme::HTTPS,
        ))
    }
}

/// Extract peer certificates from the TLS stream
fn extract_peer_certificates<T>(tls_stream: &TlsStream<T>) -> Option<Vec<u8>> {
    // Get the TLS connection info
    let (_, tls_conn) = tls_stream.get_ref();

    // Extract peer certificates - this gives us the certificate chain
    if let Some(peer_certs) = tls_conn.peer_certificates()
        && let Some(end_entity_cert) = peer_certs.first()
    {
        debug!("Extracted client certificate from TLS stream");
        return Some(end_entity_cert.as_ref().to_vec());
    }

    debug!("No client certificate found in TLS stream");
    None
}

/// Certificate data extracted from client TLS connection
#[derive(Debug, Clone)]
pub struct ClientCertificate {
    pub der_bytes: Vec<u8>,
}

/// Middleware that extracts client certificates from enhanced remote_addr and stores them in request extensions
pub struct CertificateExtractorMiddleware;

impl<E> poem::Middleware<E> for CertificateExtractorMiddleware
where
    E: poem::Endpoint,
{
    type Output = CertificateExtractorEndpoint<E>;

    fn transform(&self, ep: E) -> Self::Output {
        CertificateExtractorEndpoint { inner: ep }
    }
}

// Extracts client certificates stored in the request by [CertificateCapturingAcceptor]
pub struct CertificateExtractorEndpoint<E> {
    inner: E,
}

impl<E> poem::Endpoint for CertificateExtractorEndpoint<E>
where
    E: poem::Endpoint,
{
    type Output = E::Output;
    async fn call(&self, mut req: poem::Request) -> poem::Result<Self::Output> {
        // Extract certificate from enhanced remote_addr if present
        if let RemoteAddr(Addr::Custom("captured-cert", value)) = req.remote_addr() {
            if let Some(cert_part) = value.split("|cert:").nth(1) {
                // Decode the base64 certificate
                match base64::engine::general_purpose::STANDARD.decode(cert_part) {
                    Ok(cert_der) => {
                        debug!(
                            "Middleware: Successfully extracted client certificate from remote_addr"
                        );

                        let client_cert = ClientCertificate {
                            der_bytes: cert_der,
                        };

                        // Store certificate in request extensions for later access
                        req.extensions_mut().insert(client_cert);
                        debug!("Middleware: Client certificate stored in request extensions");
                    }
                    Err(e) => {
                        warn!(
                            "Middleware: Failed to decode client certificate from remote_addr: {}",
                            e
                        );
                    }
                }
            }
        } else {
            debug!("Middleware: No client certificate found in remote_addr");
        }

        // Continue with the request
        self.inner.call(req).await
    }
}

/// Helper trait to easily extract client certificate from request
pub trait RequestCertificateExt {
    /// Get the client certificate from request extensions, if present
    fn client_certificate(&self) -> Option<&ClientCertificate>;
}

impl RequestCertificateExt for poem::Request {
    fn client_certificate(&self) -> Option<&ClientCertificate> {
        self.extensions().get::<ClientCertificate>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::UnixTime;
    use uuid::Uuid;
    use x509_parser::prelude::{FromDer, X509Certificate};

    fn provider() -> Arc<CryptoProvider> {
        Arc::new(rustls::crypto::aws_lc_rs::default_provider())
    }

    /// PEM-wrap a `SubjectPublicKeyInfo` DER so it can be fed to
    /// `gated_ca::issue_client_certificate`.
    fn spki_pem_from_cert(cert_pem: &str) -> String {
        let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()).unwrap();
        let (_, cert) = X509Certificate::from_der(&pem.contents).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(cert.public_key().raw);
        let wrapped = b64
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        format!("-----BEGIN PUBLIC KEY-----\n{wrapped}\n-----END PUBLIC KEY-----")
    }

    fn cert_der(cert_pem: &str) -> CertificateDer<'static> {
        let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes()).unwrap();
        CertificateDer::from(pem.contents)
    }

    /// The verifier must accept a client certificate
    /// that chains to the trusted instance CA and reject one that does not
    /// (here, a certificate belonging to an unrelated CA).
    #[test]
    fn verifier_accepts_ca_signed_and_rejects_untrusted_cert() {
        // Trusted instance CA.
        let (ca_pem, ca_key) = gated_ca::generate_root_certificate_rcgen().unwrap();
        let ca = gated_ca::deserialize_ca(&ca_pem, &ca_key).unwrap();

        // An unrelated CA: source of a client public key and of a forged,
        // untrusted certificate.
        let (other_ca_pem, _other_key) = gated_ca::generate_root_certificate_rcgen().unwrap();
        let client_pubkey_pem = spki_pem_from_cert(&other_ca_pem);

        // Legitimate client certificate signed by the trusted CA.
        let client_cert =
            gated_ca::issue_client_certificate(&ca, "alice", &client_pubkey_pem, Uuid::new_v4())
                .unwrap();
        let client_pem = gated_ca::certificate_to_pem(&client_cert).unwrap();

        let verifier = build_client_cert_verifier(&ca_pem, provider()).unwrap();
        let now = UnixTime::now();

        assert!(
            verifier
                .verify_client_cert(&cert_der(&client_pem), &[], now)
                .is_ok(),
            "CA-signed client certificate must be accepted"
        );

        assert!(
            verifier
                .verify_client_cert(&cert_der(&other_ca_pem), &[], now)
                .is_err(),
            "certificate not chaining to the trusted CA must be rejected"
        );
    }
}
