use std::time::{Duration, SystemTime};

use aws_lc_rs::error::KeyRejected;
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{
    EcdsaKeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_ASN1, ECDSA_P384_SHA384_ASN1,
    ECDSA_P384_SHA384_ASN1_SIGNING,
};
use data_encoding::BASE64;
use der::{Decode, DecodePem, Encode};
use spki::{AlgorithmIdentifier, SubjectPublicKeyInfo, SubjectPublicKeyInfoOwned};
use uuid::Uuid;
use x509_cert::request::CertReq;
use x509_cert::serial_number::SerialNumber;
use x509_cert::time::Validity;
use x509_cert::{Certificate, TbsCertificate, Version};
use x509_parser::pem::parse_x509_pem;

mod error;
pub use error::CaError;

impl From<KeyRejected> for CaError {
    fn from(err: KeyRejected) -> Self {
        CaError::Other(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Key rejected: {:?}", err),
        )))
    }
}

/// A certificate and its associated private key
#[derive(Debug)]
pub struct CertifiedKey {
    /// The X.509 certificate
    pub certificate: Certificate,
    /// The private key in DER format
    pub private_key_der: Vec<u8>,
}

impl CertifiedKey {
    /// Get the certificate as PEM-encoded string
    pub fn certificate_pem(&self) -> Result<String, CaError> {
        let der = self.certificate.to_der()?;
        let pem_data = pem::Pem::new("CERTIFICATE", der);
        Ok(pem::encode(&pem_data))
    }

    /// Get the private key as PEM-encoded string
    pub fn private_key_pem(&self) -> String {
        let pem_data = pem::Pem::new("EC PRIVATE KEY", self.private_key_der.clone());
        pem::encode(&pem_data)
    }
}

pub fn generate_root_certificate_rcgen() -> Result<(String, String), CaError> {
    use rcgen::{CertificateParams, DistinguishedName, IsCa, KeyPair};

    // Create a new key pair
    let key_pair = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P384_SHA384)?;

    // Create certificate parameters
    let mut params = CertificateParams::new(vec![])?;

    // Set up distinguished name
    let mut dn = DistinguishedName::new();
    dn.push(rcgen::DnType::CommonName, "Gated Instance CA");
    params.distinguished_name = dn;

    params.is_ca = IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.not_before = SystemTime::now().into();
    params.not_after = (SystemTime::now() + Duration::from_secs(99 * 365 * 24 * 60 * 60)).into();

    // Generate the certificate
    let cert = params.self_signed(&key_pair)?;

    Ok((cert.pem(), key_pair.serialize_pem()))
}

pub fn deserialize_certificate(pem: &str) -> Result<Certificate, CaError> {
    let (_, pem_cert) = parse_x509_pem(pem.as_bytes())?;

    Ok(Certificate::from_der(&pem_cert.contents)?)
}

pub fn serialize_certificate_serial(cert: &Certificate) -> String {
    BASE64.encode(cert.tbs_certificate.serial_number.as_bytes())
}

pub fn certificate_sha256_hex_fingerprint(cert: &Certificate) -> Result<String, CaError> {
    let der = cert.to_der()?;
    let digest = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, &der);
    Ok(hex::encode(digest.as_ref()))
}

/// Deserialize a CA certificate and private key from PEM format
pub fn deserialize_ca(
    certificate_pem: &str,
    private_key_pem: &str,
) -> Result<CertifiedKey, CaError> {
    let certificate = deserialize_certificate(certificate_pem)?;

    // Parse the private key PEM
    let key_pem = pem::parse(private_key_pem).map_err(|e| {
        CaError::Other(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Failed to parse private key PEM: {:?}", e),
        )))
    })?;

    // Validate it's a private key by checking the tag
    let tag = key_pem.tag();
    let ec_private_key_tag = "PRIVATE KEY";
    if tag != ec_private_key_tag {
        return Err(CaError::InvalidKeyFormat);
    }

    Ok(CertifiedKey {
        certificate,
        private_key_der: key_pem.contents().to_vec(),
    })
}

/// Issue a client certificate signed by the CA over a bare public key.
///
/// NOTE: this path performs no proof-of-possession — the caller must be a
/// trusted operator (e.g. an admin issuing on behalf of a user). For
/// self-service issuance use [`issue_client_certificate_from_csr`], which
/// verifies that the requester holds the matching private key.
pub fn issue_client_certificate(
    ca: &CertifiedKey,
    _subject_name: &str,
    public_key_pem: &str,
    user_id: Uuid,
) -> Result<Certificate, CaError> {
    let public_key = SubjectPublicKeyInfo::from_pem(public_key_pem)?;
    build_client_certificate(ca, public_key, user_id)
}

/// Issue a client certificate from a PKCS#10 CSR, enforcing proof-of-possession.
///
/// The CSR's self-signature is verified against its embedded public key before
/// issuance; an invalid, unsigned, or unsupported CSR yields
/// [`CaError::InvalidKeyFormat`], which callers should surface as a 400. On
/// success the certificate is issued over the public key carried in the CSR.
pub fn issue_client_certificate_from_csr(
    ca: &CertifiedKey,
    csr_pem: &str,
    user_id: Uuid,
) -> Result<Certificate, CaError> {
    let csr_pem = pem::parse(csr_pem).map_err(|_| CaError::InvalidKeyFormat)?;
    if csr_pem.tag() != "CERTIFICATE REQUEST" {
        return Err(CaError::InvalidKeyFormat);
    }
    let csr = CertReq::from_der(csr_pem.contents()).map_err(|_| CaError::InvalidKeyFormat)?;

    verify_csr_signature(&csr)?;

    build_client_certificate(ca, csr.info.public_key, user_id)
}

/// Verify that a CSR is self-signed by the private key matching its embedded
/// public key. Returns [`CaError::InvalidKeyFormat`] on any mismatch or for
/// unsupported key/signature algorithms (ECDSA P-256/SHA-256 and
/// P-384/SHA-384 are accepted, matching the rest of the system).
fn verify_csr_signature(csr: &CertReq) -> Result<(), CaError> {
    use const_oid::db::rfc5912;
    use const_oid::ObjectIdentifier;

    // Only EC public keys are supported.
    if csr.info.public_key.algorithm.oid != rfc5912::ID_EC_PUBLIC_KEY {
        return Err(CaError::InvalidKeyFormat);
    }
    let curve: ObjectIdentifier = csr
        .info
        .public_key
        .algorithm
        .parameters
        .clone()
        .ok_or(CaError::InvalidKeyFormat)?
        .decode_as()
        .map_err(|_| CaError::InvalidKeyFormat)?;

    // Pair the named curve with its canonical signature algorithm.
    let verify_alg = match (curve, csr.algorithm.oid) {
        (rfc5912::SECP_256_R_1, rfc5912::ECDSA_WITH_SHA_256) => &ECDSA_P256_SHA256_ASN1,
        (rfc5912::SECP_384_R_1, rfc5912::ECDSA_WITH_SHA_384) => &ECDSA_P384_SHA384_ASN1,
        _ => return Err(CaError::InvalidKeyFormat),
    };

    // The public key point (uncompressed SEC1) and the DER-encoded signature.
    let public_key_bytes = csr
        .info
        .public_key
        .subject_public_key
        .as_bytes()
        .ok_or(CaError::InvalidKeyFormat)?;
    let signature = csr
        .signature
        .as_bytes()
        .ok_or(CaError::InvalidKeyFormat)?;

    // The signed payload is the DER encoding of CertificationRequestInfo.
    let signed = csr.info.to_der()?;

    UnparsedPublicKey::new(verify_alg, public_key_bytes)
        .verify(&signed, signature)
        .map_err(|_| CaError::InvalidKeyFormat)
}

/// Build and CA-sign a client certificate over an already-validated public key.
fn build_client_certificate(
    ca: &CertifiedKey,
    public_key: SubjectPublicKeyInfoOwned,
    user_id: Uuid,
) -> Result<Certificate, CaError> {
    use const_oid::db::{rfc4519, rfc5280, rfc5912};
    use der::asn1::{OctetString, SetOfVec, Utf8StringRef};
    use x509_cert::attr::AttributeTypeAndValue;
    use x509_cert::ext::pkix::{BasicConstraints, ExtendedKeyUsage, KeyUsage, KeyUsages};
    use x509_cert::ext::Extension;
    use x509_cert::name::{RdnSequence, RelativeDistinguishedName};

    // Sign with ECDSA-P384/SHA-384 to match the `ecdsa-with-SHA384` algorithm
    // identifier embedded in the issued certificate below; a mismatched digest
    // would make the chain unverifiable by rustls/webpki.
    let ca_key_pair =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P384_SHA384_ASN1_SIGNING, &ca.private_key_der)?;

    let validity = {
        let validity = Duration::from_secs(365 * 24 * 60 * 60);
        let now = SystemTime::now();
        Validity {
            not_before: now.try_into()?,
            not_after: (now + validity).try_into()?,
        }
    };

    let subject = {
        let name_attrs = vec![AttributeTypeAndValue {
            oid: rfc4519::UID,
            value: Utf8StringRef::new(&user_id.to_string())?.into(),
        }];

        let rdn = RelativeDistinguishedName::from(SetOfVec::try_from(name_attrs)?);
        RdnSequence::from(vec![rdn])
    };

    // Get the issuer name from the CA certificate
    let issuer = ca.certificate.tbs_certificate.issuer.clone();

    let serial_number = {
        // Draw the serial from a CSPRNG. A hash of
        // subject+timestamp is predictable; RFC 5280 wants an unpredictable
        // serial with adequate entropy. 16 random bytes (128 bits); the top
        // byte is masked into 0x40..=0x7f so the DER INTEGER is positive,
        // non-zero, and free of a redundant leading zero octet.
        let rng = SystemRandom::new();
        let mut serial_bytes = [0u8; 16];
        rng.fill(&mut serial_bytes)?;
        serial_bytes[0] = (serial_bytes[0] & 0x7f) | 0x40;
        SerialNumber::new(&serial_bytes)?
    };

    let tbs_cert = TbsCertificate {
        version: Version::V3,
        serial_number,
        signature: AlgorithmIdentifier {
            oid: rfc5912::ECDSA_WITH_SHA_384,
            parameters: None,
        },
        issuer,
        validity,
        subject,
        subject_public_key_info: public_key,
        issuer_unique_id: None,
        subject_unique_id: None,
        extensions: Some(vec![
            Extension {
                extn_id: rfc5280::ID_CE_BASIC_CONSTRAINTS,
                critical: true,
                extn_value: OctetString::new(
                    BasicConstraints {
                        ca: false,
                        path_len_constraint: None,
                    }
                    .to_der()?,
                )?,
            },
            Extension {
                extn_id: rfc5280::ID_CE_KEY_USAGE,
                critical: true,
                extn_value: OctetString::new({
                    (KeyUsage::from(
                        KeyUsages::DigitalSignature
                            | KeyUsages::KeyEncipherment
                            | KeyUsages::DataEncipherment,
                    ))
                    .to_der()?
                })?,
            },
            // Mark the cert for TLS client authentication. These
            // are mTLS PoP client certs; without an EKU a strict verifier may
            // reject them for client-auth use.
            Extension {
                extn_id: rfc5280::ID_CE_EXT_KEY_USAGE,
                critical: false,
                extn_value: OctetString::new(
                    ExtendedKeyUsage(vec![rfc5280::ID_KP_CLIENT_AUTH]).to_der()?,
                )?,
            },
        ]),
    };

    let signature = {
        // Sign the certificate
        let rng = SystemRandom::new();
        let tbs_cert_der = tbs_cert.to_der()?;
        ca_key_pair.sign(&rng, &tbs_cert_der)?
    };

    let certificate = Certificate {
        tbs_certificate: tbs_cert,
        signature_algorithm: AlgorithmIdentifier {
            oid: rfc5912::ECDSA_WITH_SHA_384,
            parameters: None,
        },
        signature: der::asn1::BitString::from_bytes(signature.as_ref())?,
    };

    Ok(certificate)
}

/// Convert a certificate to PEM format
pub fn certificate_to_pem(certificate: &Certificate) -> Result<String, CaError> {
    let der = certificate.to_der()?;
    let pem_data = pem::Pem::new("CERTIFICATE", der);
    Ok(pem::encode(&pem_data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use const_oid::db::rfc5280;
    use const_oid::ObjectIdentifier;
    use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
    use x509_cert::ext::pkix::ExtendedKeyUsage;

    fn test_ca() -> CertifiedKey {
        let (cert_pem, key_pem) = generate_root_certificate_rcgen().unwrap();
        deserialize_ca(&cert_pem, &key_pem).unwrap()
    }

    fn client_csr_pem() -> String {
        let kp = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let params = CertificateParams::new(vec![]).unwrap();
        params.serialize_request(&kp).unwrap().pem().unwrap()
    }

    fn eku_oids(cert: &Certificate) -> Vec<ObjectIdentifier> {
        let ext = cert
            .tbs_certificate
            .extensions
            .as_ref()
            .expect("extensions present")
            .iter()
            .find(|e| e.extn_id == rfc5280::ID_CE_EXT_KEY_USAGE)
            .expect("EKU extension present");
        ExtendedKeyUsage::from_der(ext.extn_value.as_bytes())
            .unwrap()
            .0
    }

    #[test]
    fn issued_cert_has_client_auth_eku() {
        let ca = test_ca();
        let kp = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let cert =
            issue_client_certificate(&ca, "alice", &kp.public_key_pem(), Uuid::new_v4()).unwrap();
        assert!(eku_oids(&cert).contains(&rfc5280::ID_KP_CLIENT_AUTH));
    }

    #[test]
    fn serial_is_csprng_and_unique() {
        let ca = test_ca();
        let kp = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let c1 = issue_client_certificate(&ca, "a", &kp.public_key_pem(), Uuid::new_v4()).unwrap();
        let c2 = issue_client_certificate(&ca, "a", &kp.public_key_pem(), Uuid::new_v4()).unwrap();
        let s1 = c1.tbs_certificate.serial_number.as_bytes();
        let s2 = c2.tbs_certificate.serial_number.as_bytes();
        // Two issuances with the same subject/key still get distinct serials —
        // the old hash(subject ‖ now) scheme could collide and is predictable.
        assert_ne!(s1, s2);
        assert!(s1.len() >= 8, "serial must carry >= 8 bytes of entropy");
        assert_eq!(s1[0] & 0x80, 0, "serial must be a positive integer");
    }

    #[test]
    fn csr_issuance_succeeds_and_has_eku() {
        let ca = test_ca();
        let csr_pem = client_csr_pem();
        let cert = issue_client_certificate_from_csr(&ca, &csr_pem, Uuid::new_v4()).unwrap();
        assert!(eku_oids(&cert).contains(&rfc5280::ID_KP_CLIENT_AUTH));
    }

    #[test]
    fn csr_with_mismatched_signature_is_rejected() {
        let ca = test_ca();

        // Two independently-signed CSRs; graft the second's signature onto the
        // first so the signature no longer matches the embedded public key.
        let der1 = pem::parse(client_csr_pem()).unwrap();
        let der2 = pem::parse(client_csr_pem()).unwrap();
        let csr1 = CertReq::from_der(der1.contents()).unwrap();
        let csr2 = CertReq::from_der(der2.contents()).unwrap();

        let tampered = CertReq {
            info: csr1.info.clone(),
            algorithm: csr1.algorithm.clone(),
            signature: csr2.signature.clone(),
        };
        let tampered_pem =
            pem::encode(&pem::Pem::new("CERTIFICATE REQUEST", tampered.to_der().unwrap()));

        let err =
            issue_client_certificate_from_csr(&ca, &tampered_pem, Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, CaError::InvalidKeyFormat));
    }

    #[test]
    fn malformed_csr_is_rejected() {
        let ca = test_ca();
        let err = issue_client_certificate_from_csr(&ca, "not a csr", Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, CaError::InvalidKeyFormat));
    }
}
