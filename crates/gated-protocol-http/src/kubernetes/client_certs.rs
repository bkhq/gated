use std::sync::Arc;

use rustls::RootCertStore;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::CertificateDer;
use rustls::server::WebPkiClientVerifier;
use rustls::server::danger::ClientCertVerifier;

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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
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
