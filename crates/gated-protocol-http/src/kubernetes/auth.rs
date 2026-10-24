//! Client-certificate validation for the HTTP-proxy listener.
//!
//! This is the only auth helper the K8s flavor still owns — it knows how to
//! match an incoming mTLS client certificate to a `CertificateCredential`
//! row and resolve the bound user.  Bearer-token validation lives in the
//! shared listener (see `crate::server`).

use gated_ca::{deserialize_certificate, serialize_certificate_serial};
use gated_common::User;
use gated_common::auth::AuthStateUserInfo;
use gated_core::Services;
use gated_db_entities::{CertificateCredential, CertificateRevocation};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use tracing::*;

/// Validate the provided client certificate (DER) against
/// `certificate_credentials` rows; if it matches a credential whose serial
/// is not in `certificate_revocations`, return the bound user.
pub async fn validate_client_certificate(
    cert_der: &[u8],
    services: &Services,
) -> anyhow::Result<Option<AuthStateUserInfo>> {
    let cert_pem = der_to_pem(cert_der)?;

    let db = services.db_required().await?;

    let cert = deserialize_certificate(&cert_pem)?;
    let serial_b64 = serialize_certificate_serial(&cert);
    if CertificateRevocation::Entity::find()
        .filter(CertificateRevocation::Column::SerialNumberBase64.eq(&serial_b64))
        .one(&db)
        .await?
        .is_some()
    {
        warn!(serial = %serial_b64, "Client certificate is revoked");
        return Ok(None);
    }

    let cert_credentials = CertificateCredential::Entity::find()
        .find_with_related(gated_db_entities::User::Entity)
        .all(&db)
        .await?;

    for (cert_credential, users) in cert_credentials {
        if let Some(user) = users.into_iter().next() {
            // The TLS layer has already cryptographically verified that the
            // presented certificate chains to the instance CA and that the
            // client holds the matching private key (proof-of-possession; see
            // `client_certs::build_client_cert_verifier`). Resolve the bound
            // user by the certificate's CA-issued serial number — the stable
            // identity of the verified credential — instead of comparing raw
            // certificate blobs, which alone is not proof-of-possession.
            let Ok(stored_cert) = deserialize_certificate(&cert_credential.certificate_pem) else {
                warn!(
                    cert_label = cert_credential.label,
                    "Stored certificate credential is unparseable; skipping"
                );
                continue;
            };

            if serialize_certificate_serial(&stored_cert) == serial_b64 {
                debug!(
                    user = user.username,
                    cert_label = cert_credential.label,
                    "Client certificate validated for user"
                );

                let mut active_model: CertificateCredential::ActiveModel = cert_credential.into();
                active_model.last_used = Set(Some(chrono::Utc::now()));
                if let Err(e) = active_model.update(&db).await {
                    warn!("Failed to update certificate last_used timestamp: {}", e);
                }

                return Ok(Some((&User::try_from(user)?).into()));
            }
        }
    }

    Ok(None)
}

fn der_to_pem(der_bytes: &[u8]) -> anyhow::Result<String> {
    use base64::Engine as _;
    use base64::engine::general_purpose;
    let cert_b64 = general_purpose::STANDARD.encode(der_bytes);
    let cert_lines: Vec<String> = cert_b64
        .chars()
        .collect::<Vec<char>>()
        .chunks(64)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect();

    Ok(format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----",
        cert_lines.join("\n")
    ))
}
