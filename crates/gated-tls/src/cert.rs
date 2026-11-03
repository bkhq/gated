use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::ResolvesServerCert;
use rustls::sign::{CertifiedKey, SigningKey};
use rustls_pki_types::pem::PemObject;
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use x509_parser::prelude::{FromDer, GeneralName, ParsedExtension, X509Certificate};

use crate::RustlsSetupError;

#[derive(Debug, Clone)]
pub struct TlsCertificateBundle {
    bytes: Vec<u8>,
    certificates: Vec<CertificateDer<'static>>,
}

#[derive(Debug, Clone)]
pub struct TlsPrivateKey {
    bytes: Vec<u8>,
    key: Arc<dyn SigningKey>,
}

impl TlsPrivateKey {
    pub fn key(&self) -> &Arc<dyn SigningKey> {
        &self.key
    }
}

#[derive(Debug, Clone)]
pub struct TlsCertificateAndPrivateKey {
    pub certificate: TlsCertificateBundle,
    pub private_key: TlsPrivateKey,
}

impl TlsCertificateBundle {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn certificates(&self) -> &[CertificateDer<'static>] {
        &self.certificates
    }

    pub async fn from_file<P: AsRef<Path>>(path: P) -> Result<Self, RustlsSetupError> {
        let mut file = File::open(path).await?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        Self::from_bytes(bytes)
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, RustlsSetupError> {
        let certificates = CertificateDer::pem_slice_iter(&bytes[..])
            .collect::<Result<Vec<CertificateDer<'static>>, _>>()?;

        if certificates.is_empty() {
            return Err(RustlsSetupError::NoCertificates);
        }

        Ok(Self {
            bytes,
            certificates,
        })
    }

    pub fn sni_names(&self) -> Result<Vec<String>, RustlsSetupError> {
        // Parse leaf certificate
        let Some(cert_der) = self.certificates.first() else {
            return Ok(Vec::new());
        };

        let (_, cert) =
            X509Certificate::from_der(cert_der).map_err(|e| RustlsSetupError::X509(e.into()))?;

        let mut names = Vec::new();

        if let Some(san_ext) = cert
            .extensions()
            .iter()
            .find(|ext| ext.oid == x509_parser::oid_registry::OID_X509_EXT_SUBJECT_ALT_NAME)
        {
            let san = san_ext.parsed_extension();
            if let ParsedExtension::SubjectAlternativeName(san) = san {
                for name in &san.general_names {
                    match name {
                        GeneralName::DNSName(dns_name) => {
                            names.push(dns_name.to_string());
                        }
                        GeneralName::IPAddress(ip_bytes) => {
                            if ip_bytes.len() == 4 {
                                #[allow(clippy::unwrap_used)] // length checked
                                names.push(
                                    Ipv4Addr::from(<[u8; 4]>::try_from(*ip_bytes).unwrap())
                                        .to_string(),
                                );
                            } else if ip_bytes.len() == 16 {
                                #[allow(clippy::unwrap_used)] // length checked
                                names.push(
                                    Ipv6Addr::from(<[u8; 16]>::try_from(*ip_bytes).unwrap())
                                        .to_string(),
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        if let Some(subject) = cert.subject().iter_common_name().next()
            && let Ok(cn) = subject.as_str()
        {
            names.push(cn.to_string());
        }

        // Remove duplicates while preserving order
        let mut unique_names = Vec::new();
        for name in names {
            if !unique_names.contains(&name) {
                unique_names.push(name);
            }
        }

        Ok(unique_names)
    }
}

impl TlsPrivateKey {
    pub async fn from_file<P: AsRef<Path>>(path: P) -> Result<Self, RustlsSetupError> {
        let mut file = File::open(path).await?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        Self::from_bytes(bytes)
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, RustlsSetupError> {
        let key = PrivateKeyDer::from_pem_slice(bytes.as_slice())?;
        let key = rustls::crypto::aws_lc_rs::sign::any_supported_type(&key)?;

        Ok(Self { bytes, key })
    }
}

impl TlsCertificateAndPrivateKey {
    /// Parses a PEM certificate chain and private key, rejecting a key that
    /// does not belong to the leaf certificate.
    pub fn from_pem(certificate: &[u8], private_key: &[u8]) -> Result<Self, RustlsSetupError> {
        let pair = Self {
            certificate: TlsCertificateBundle::from_bytes(certificate.to_vec())?,
            private_key: TlsPrivateKey::from_bytes(private_key.to_vec())?,
        };
        CertifiedKey::from(pair.clone()).keys_match()?;
        Ok(pair)
    }
}

impl From<TlsCertificateBundle> for Vec<u8> {
    fn from(val: TlsCertificateBundle) -> Self {
        val.bytes
    }
}

impl From<TlsPrivateKey> for Vec<u8> {
    fn from(val: TlsPrivateKey) -> Self {
        val.bytes
    }
}

impl From<TlsCertificateAndPrivateKey> for CertifiedKey {
    fn from(val: TlsCertificateAndPrivateKey) -> Self {
        let cert = val.certificate;
        let key = val.private_key;
        CertifiedKey {
            cert: cert.certificates,
            key: key.key,
            ocsp: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SingleCertResolver(Arc<CertifiedKey>);

impl SingleCertResolver {
    pub fn new(inner: TlsCertificateAndPrivateKey) -> Self {
        Self(Arc::new(inner.into()))
    }
}

impl ResolvesServerCert for SingleCertResolver {
    fn resolve(
        &self,
        _client_hello: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<rustls::sign::CertifiedKey>> {
        Some(self.0.clone())
    }
}

/// Serves a certificate that can be replaced while the listener runs.
/// Handshakes fail until the first certificate is set.
#[derive(Debug, Default)]
pub struct ReloadableCertResolver(RwLock<Option<Arc<CertifiedKey>>>);

impl ReloadableCertResolver {
    pub fn set(&self, certificate: TlsCertificateAndPrivateKey) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) =
            Some(Arc::new(certificate.into()));
    }

    pub fn current(&self) -> Option<Arc<CertifiedKey>> {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl ResolvesServerCert for ReloadableCertResolver {
    fn resolve(
        &self,
        _client_hello: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<rustls::sign::CertifiedKey>> {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// Picks the certificate registered for the requested server name, falling
/// back to the default one.
#[derive(Debug, Clone)]
pub struct SniCertResolver {
    fallback: Arc<ReloadableCertResolver>,
    by_name: HashMap<String, Arc<CertifiedKey>>,
}

impl SniCertResolver {
    pub fn new(fallback: Arc<ReloadableCertResolver>) -> Self {
        Self {
            fallback,
            by_name: HashMap::new(),
        }
    }

    pub fn add(&mut self, name: String, certificate: TlsCertificateAndPrivateKey) {
        self.by_name.insert(name, Arc::new(certificate.into()));
    }
}

impl ResolvesServerCert for SniCertResolver {
    fn resolve(
        &self,
        client_hello: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<rustls::sign::CertifiedKey>> {
        client_hello
            .server_name()
            .and_then(|name| self.by_name.get(name).cloned())
            .or_else(|| self.fallback.current())
    }
}

pub trait IntoTlsCertificateRelativePaths {
    fn certificate_path(&self) -> PathBuf;
    fn key_path(&self) -> PathBuf;
}
