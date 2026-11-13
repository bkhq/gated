//! TLS for the connection to the target.

use std::sync::Arc;

use anyhow::{Context, Result};
use gated_tls::configure_tls_connector;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::client::Resumption;
use tokio_rustls::rustls::pki_types::ServerName;
use x509_parser::prelude::{FromDer, X509Certificate};

/// Wrap `stream` in TLS. Also returns the target's public key, which
/// CredSSP binds the logon to.
pub async fn upgrade(
    stream: TcpStream,
    server_name: &str,
    verify: bool,
) -> Result<(TlsStream<TcpStream>, Vec<u8>)> {
    let mut config = configure_tls_connector(!verify, false, None)
        .await
        .context("TLS configuration")?;
    // CredSSP is bound to the certificate of this handshake.
    config.resumption = Resumption::disabled();

    let name = ServerName::try_from(server_name.to_owned()).context("invalid server name")?;
    let stream = TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .context("TLS handshake")?;

    let certificate = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .context("the target sent no certificate")?;
    let public_key = server_public_key(certificate.as_ref())?;

    Ok((stream, public_key))
}

/// The subject public key of a DER certificate, without the algorithm
/// wrapper: the bytes CredSSP hashes.
fn server_public_key(certificate: &[u8]) -> Result<Vec<u8>> {
    let (_, certificate) =
        X509Certificate::from_der(certificate).context("parsing the target's certificate")?;
    Ok(certificate
        .tbs_certificate
        .subject_pki
        .subject_public_key
        .data
        .to_vec())
}
