//! Certificate chain presented by an HTTP target's upstream.

use std::time::Duration;

use axum::extract::Path;
use gated_common::web::{Data, Json};
use gated_common::{GatedError, Target as TargetConfig, TargetOptions, api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::Target;
use sea_orm::EntityTrait;
use serde::Serialize;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::{FromDer, X509Certificate};

use super::AnySecurityScheme;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, ToSchema)]
struct CertificateInfo {
    subject: String,
    issuer: String,
    serial: String,
    /// RFC 3339.
    not_before: String,
    /// RFC 3339.
    not_after: String,
    /// DNS names and IP addresses from the subjectAltName extension.
    subject_alt_names: Vec<String>,
    /// Uppercase colon-separated SHA-256 of the DER certificate.
    sha256_fingerprint: String,
}

#[derive(Serialize, ToSchema)]
struct UpstreamCertificate {
    /// False for an `http://` upstream; nothing else is reported then.
    tls: bool,
    /// The target's `tls.verify` setting.
    verify: bool,
    /// Leaf first.
    chain: Vec<CertificateInfo>,
    /// Why the chain fails verification against the system roots and the
    /// target's CA bundle; null when it verifies.
    verify_error: Option<String>,
    /// Why the upstream could not be reached.
    error: Option<String>,
}

api_response! {
    enum UpstreamCertificateResponse {
        #[oai(status = 200)]
        Ok(Json<UpstreamCertificate>),
        #[oai(status = 400)]
        InvalidType,
        #[oai(status = 404)]
        NotFound,
    }
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn rfc3339(time: x509_parser::time::ASN1Time) -> String {
    chrono::DateTime::from_timestamp(time.timestamp(), 0)
        .map(|time| time.to_rfc3339())
        .unwrap_or_default()
}

fn describe(der: &[u8]) -> Option<CertificateInfo> {
    let (_, cert) = X509Certificate::from_der(der).ok()?;
    let subject_alt_names = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|ext| {
            ext.value
                .general_names
                .iter()
                .filter_map(|name| match name {
                    GeneralName::DNSName(dns) => Some((*dns).to_owned()),
                    GeneralName::IPAddress(ip) => match ip.len() {
                        4 => <[u8; 4]>::try_from(*ip)
                            .ok()
                            .map(|ip| std::net::IpAddr::from(ip).to_string()),
                        16 => <[u8; 16]>::try_from(*ip)
                            .ok()
                            .map(|ip| std::net::IpAddr::from(ip).to_string()),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    Some(CertificateInfo {
        subject: cert.subject().to_string(),
        issuer: cert.issuer().to_string(),
        serial: cert.raw_serial_as_string(),
        not_before: rfc3339(cert.validity().not_before),
        not_after: rfc3339(cert.validity().not_after),
        subject_alt_names,
        sha256_fingerprint: fingerprint(der),
    })
}

#[utoipa::path(
    get,
    path = "/targets/{id}/upstream-certificate",
    operation_id = "get_target_upstream_certificate"
)]
async fn api_get_upstream_certificate(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<UpstreamCertificateResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let Some(target) = Target::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(UpstreamCertificateResponse::NotFound);
    };
    let target: TargetConfig = target.try_into()?;
    let TargetOptions::Http(options) = target.options else {
        return Ok(UpstreamCertificateResponse::InvalidType);
    };

    let mut report = UpstreamCertificate {
        tls: false,
        verify: options.tls.verify,
        chain: vec![],
        verify_error: None,
        error: None,
    };
    let url = match url::Url::parse(&options.url) {
        Ok(url) => url,
        Err(error) => {
            report.error = Some(format!("invalid upstream URL: {error}"));
            return Ok(UpstreamCertificateResponse::Ok(Json(report)));
        }
    };
    if url.scheme() != "https" {
        return Ok(UpstreamCertificateResponse::Ok(Json(report)));
    }
    report.tls = true;
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        report.error = Some("the upstream URL has no host".into());
        return Ok(UpstreamCertificateResponse::Ok(Json(report)));
    };
    // `Url` keeps IPv6 hosts bracketed.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let ca = options
        .ca_certificate
        .as_ref()
        .map(|ca| ca.expose_secret().clone());

    match gated_tls::inspect_peer_chain(
        host,
        port,
        ca.as_deref().map(str::as_bytes),
        HANDSHAKE_TIMEOUT,
    )
    .await
    {
        Ok(chain) => {
            report.chain = chain
                .certificates
                .iter()
                .filter_map(|der| describe(der))
                .collect();
            report.verify_error = chain.verify_error;
        }
        Err(error) => report.error = Some(error.to_string()),
    }
    Ok(UpstreamCertificateResponse::Ok(Json(report)))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_upstream_certificate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_a_certificate() {
        let key = rcgen::KeyPair::generate().expect("key");
        let mut params =
            rcgen::CertificateParams::new(vec!["upstream.test".into(), "10.0.0.7".into()])
                .expect("params");
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "upstream.test");
        let cert = params.self_signed(&key).expect("cert");

        let info = describe(cert.der()).expect("parse");
        assert_eq!(info.subject, "CN=upstream.test");
        assert_eq!(info.subject_alt_names, ["upstream.test", "10.0.0.7"]);
        assert_eq!(info.sha256_fingerprint.len(), 32 * 3 - 1);
        assert!(info.not_before < info.not_after);
    }
}
