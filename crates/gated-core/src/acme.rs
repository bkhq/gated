//! ACME (DNS-01) issuance and renewal of listener certificates. One account
//! and DNS provider configuration is shared by all listeners; each listener
//! has its own domain list. Challenge records are written through an
//! httpreq endpoint (lego's `httpreq` protocol) or an acme-dns server.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use gated_db_entities::{AcmeCertificate, AcmeSettings};
use instant_acme::{
    Account, AuthorizationStatus, BodyWrapper, BytesResponse, ChallengeType, HttpClient,
    Identifier, NewAccount, NewOrder, OrderStatus, RetryPolicy,
};
use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use tokio::sync::Mutex;
use tracing::{info, warn};
use x509_parser::pem::Pem;

use crate::Services;
use crate::tls_certificates::{self, TlsListener};

pub const PROVIDER_HTTPREQ: &str = "httpreq";
pub const PROVIDER_ACME_DNS: &str = "acme-dns";

/// Certificates are renewed once they have less than this left.
const RENEW_BEFORE: chrono::Duration = chrono::Duration::days(30);
/// A failed attempt is not retried automatically within this window, which
/// keeps a broken setup clear of the CA's failed-validation rate limits.
const RETRY_AFTER_FAILURE: chrono::Duration = chrono::Duration::hours(1);
const RENEWAL_CHECK_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);
const ORDER_TIMEOUT: Duration = Duration::from_secs(180);

/// Serializes issuance so concurrent requests do not race on the account.
static ISSUE_LOCK: Mutex<()> = Mutex::const_new(());

pub async fn load_settings(services: &Services) -> Result<Option<AcmeSettings::Model>> {
    let db = services.db_required().await?;
    Ok(AcmeSettings::Entity::find_by_id(1).one(&db).await?)
}

pub async fn load_listener(
    services: &Services,
    listener: TlsListener,
) -> Result<Option<AcmeCertificate::Model>> {
    let db = services.db_required().await?;
    Ok(AcmeCertificate::Entity::find_by_id(listener.as_str())
        .one(&db)
        .await?)
}

pub fn domains(row: &AcmeCertificate::Model) -> Vec<String> {
    serde_json::from_str(&row.domains).unwrap_or_default()
}

/// Stops issuing and renewing the listener's certificate through ACME. The
/// current certificate stays in place.
pub async fn disable(services: &Services, listener: TlsListener) -> Result<()> {
    let db = services.db_required().await?;
    AcmeCertificate::Entity::delete_by_id(listener.as_str())
        .exec(&db)
        .await?;
    Ok(())
}

/// Sets the listener's ACME domains and issues a certificate for them now.
/// The outcome is recorded on the listener either way.
pub async fn enable(
    services: &Services,
    listener: TlsListener,
    domains: Vec<String>,
) -> Result<()> {
    let db = services.db_required().await?;
    let existing = AcmeCertificate::Entity::find_by_id(listener.as_str())
        .one(&db)
        .await?;
    let domains_json = serde_json::to_string(&domains)?;
    match existing {
        Some(row) => {
            let mut row = row.into_active_model();
            row.domains = Set(domains_json);
            row.update(&db).await?;
        }
        None => {
            AcmeCertificate::ActiveModel {
                listener: Set(listener.as_str().to_owned()),
                domains: Set(domains_json),
                last_attempt: Set(None),
                last_success: Set(None),
                last_error: Set(None),
            }
            .insert(&db)
            .await?;
        }
    }
    issue(services, listener).await
}

/// Issues a certificate for the listener's ACME domains and installs it,
/// recording the attempt on the listener.
pub async fn issue(services: &Services, listener: TlsListener) -> Result<()> {
    let _guard = ISSUE_LOCK.lock().await;
    let row = load_listener(services, listener)
        .await?
        .context("ACME is not enabled for this listener")?;
    let result = issue_inner(services, listener, &domains(&row)).await;

    let db = services.db_required().await?;
    let mut active = row.into_active_model();
    let now = Utc::now();
    active.last_attempt = Set(Some(now));
    match &result {
        Ok(()) => {
            active.last_success = Set(Some(now));
            active.last_error = Set(None);
        }
        Err(error) => active.last_error = Set(Some(format!("{error:#}"))),
    }
    active.update(&db).await?;
    result
}

async fn issue_inner(services: &Services, listener: TlsListener, domains: &[String]) -> Result<()> {
    if domains.is_empty() {
        bail!("no domains configured");
    }
    let settings = load_settings(services)
        .await?
        .context("ACME is not configured")?;
    let http = http_client(&settings)?;
    let account = account(services, &settings, &http).await?;

    let identifiers: Vec<Identifier> = domains.iter().cloned().map(Identifier::Dns).collect();
    let mut order = account.new_order(&NewOrder::new(&identifiers)).await?;

    // Publish every challenge record first, wait once, then validate.
    let mut records = Vec::new();
    let mut authorizations = order.authorizations();
    while let Some(authz) = authorizations.next().await {
        let mut authz = authz?;
        match authz.status {
            AuthorizationStatus::Pending => {}
            AuthorizationStatus::Valid => continue,
            status => bail!("authorization is {status:?}"),
        }
        let challenge = authz
            .challenge(ChallengeType::Dns01)
            .context("the CA offers no dns-01 challenge")?;
        let Identifier::Dns(domain) = challenge.identifier().identifier else {
            bail!("unsupported identifier {}", challenge.identifier());
        };
        let record = ChallengeRecord {
            domain: domain.clone(),
            value: challenge.key_authorization().dns_value(),
        };
        present(&http, &settings, &record).await?;
        records.push(record);
    }

    let result = async {
        if !records.is_empty() {
            let delay = u64::try_from(settings.propagation_delay_secs).unwrap_or(0);
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        let mut authorizations = order.authorizations();
        while let Some(authz) = authorizations.next().await {
            let mut authz = authz?;
            if authz.status != AuthorizationStatus::Pending {
                continue;
            }
            if let Some(mut challenge) = authz.challenge(ChallengeType::Dns01) {
                challenge.set_ready().await?;
            }
        }
        let retry = RetryPolicy::new().timeout(ORDER_TIMEOUT);
        let status = order.poll_ready(&retry).await?;
        if status != OrderStatus::Ready {
            bail!("order is {status:?}: {:?}", order.state().error);
        }
        let private_key_pem = order.finalize().await?;
        let certificate_pem = order.poll_certificate(&retry).await?;
        anyhow::Ok((certificate_pem, private_key_pem))
    }
    .await;

    for record in &records {
        if let Err(error) = cleanup(&http, &settings, record).await {
            warn!(domain = %record.domain, %error, "Removing the ACME challenge record failed");
        }
    }

    let (certificate_pem, private_key_pem) = result?;
    tls_certificates::install(services, listener, certificate_pem, private_key_pem)
        .await
        .map_err(|error| anyhow::anyhow!(error))?;
    info!(
        listener = listener.as_str(),
        ?domains,
        "Installed an ACME certificate"
    );
    Ok(())
}

async fn account(
    services: &Services,
    settings: &AcmeSettings::Model,
    http: &AcmeHttp,
) -> Result<Account> {
    let builder = Account::builder_with_http(Box::new(http.clone()));
    if let Some(credentials) = &settings.account_credentials {
        let credentials = serde_json::from_str(credentials).context("stored ACME account")?;
        return Ok(builder.from_credentials(credentials).await?);
    }
    let contact = format!("mailto:{}", settings.contact_email);
    let contacts: Vec<&str> = if settings.contact_email.is_empty() {
        vec![]
    } else {
        vec![contact.as_str()]
    };
    let (account, credentials) = builder
        .create(
            &NewAccount {
                contact: &contacts,
                terms_of_service_agreed: true,
                only_return_existing: false,
            },
            settings.directory_url.clone(),
            None,
        )
        .await
        .context("registering the ACME account")?;
    let db = services.db_required().await?;
    let mut active = settings.clone().into_active_model();
    active.account_credentials = Set(Some(serde_json::to_string(&credentials)?));
    active.update(&db).await?;
    info!(id = account.id(), "Registered an ACME account");
    Ok(account)
}

/// Whether the listener's certificate must be (re)issued for `domains`.
pub fn renewal_due(certificate_pem: Option<&str>, domains: &[String], now: DateTime<Utc>) -> bool {
    let Some(leaf) = certificate_pem.and_then(|pem| Pem::iter_from_buffer(pem.as_bytes()).next())
    else {
        return true;
    };
    let Ok(leaf) = leaf else { return true };
    let Ok(cert) = leaf.parse_x509() else {
        return true;
    };
    let Some(not_after) = DateTime::<Utc>::from_timestamp(cert.validity().not_after.timestamp(), 0)
    else {
        return true;
    };
    if not_after - now < RENEW_BEFORE {
        return true;
    }
    let mut names: Vec<String> = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .map(|san| {
            san.value
                .general_names
                .iter()
                .filter_map(|name| match name {
                    x509_parser::extensions::GeneralName::DNSName(dns) => Some((*dns).to_owned()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let mut wanted = domains.to_vec();
    names.sort();
    wanted.sort();
    names != wanted
}

/// Issues certificates that are missing, expiring or for other domains.
pub async fn renew_due(services: &Services) -> Result<()> {
    let db = services.db_required().await?;
    let rows = AcmeCertificate::Entity::find().all(&db).await?;
    let now = Utc::now();
    for row in rows {
        let Some(listener) = TlsListener::parse(&row.listener) else {
            continue;
        };
        if row.last_error.is_some()
            && row
                .last_attempt
                .is_some_and(|attempt| now - attempt < RETRY_AFTER_FAILURE)
        {
            continue;
        }
        let current = tls_certificates::current(services, listener).await?;
        let pem = current.as_ref().map(|c| c.certificate_pem.as_str());
        if !renewal_due(pem, &domains(&row), now) {
            continue;
        }
        info!(
            listener = listener.as_str(),
            "Renewing the ACME certificate"
        );
        if let Err(error) = issue(services, listener).await {
            warn!(
                listener = listener.as_str(),
                error = format!("{error:#}"),
                "ACME renewal failed"
            );
        }
    }
    Ok(())
}

/// Checks for due renewals periodically, forever.
pub async fn run_renewals(services: Services) {
    loop {
        if let Err(error) = renew_due(&services).await {
            warn!(error = format!("{error:#}"), "ACME renewal check failed");
        }
        tokio::time::sleep(RENEWAL_CHECK_INTERVAL).await;
    }
}

struct ChallengeRecord {
    /// Identifier without a wildcard label.
    domain: String,
    value: String,
}

fn endpoint(settings: &AcmeSettings::Model, path: &str) -> String {
    format!("{}/{path}", settings.dns_endpoint.trim_end_matches('/'))
}

async fn present(
    http: &AcmeHttp,
    settings: &AcmeSettings::Model,
    record: &ChallengeRecord,
) -> Result<()> {
    let request = match settings.dns_provider.as_str() {
        PROVIDER_HTTPREQ => http
            .0
            .post(endpoint(settings, "present"))
            .basic_auth(&settings.dns_username, Some(&settings.dns_password))
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(
                serde_json::json!({
                    "fqdn": format!("_acme-challenge.{}.", record.domain),
                    "value": record.value,
                })
                .to_string(),
            ),
        PROVIDER_ACME_DNS => http
            .0
            .post(endpoint(settings, "update"))
            .header("X-Api-User", &settings.dns_username)
            .header("X-Api-Key", &settings.dns_password)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(
                serde_json::json!({
                    "subdomain": settings.dns_subdomain,
                    "txt": record.value,
                })
                .to_string(),
            ),
        other => bail!("unknown DNS provider {other:?}"),
    };
    request
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .with_context(|| format!("publishing the challenge record for {}", record.domain))?;
    Ok(())
}

async fn cleanup(
    http: &AcmeHttp,
    settings: &AcmeSettings::Model,
    record: &ChallengeRecord,
) -> Result<()> {
    // acme-dns keeps the two most recent records and has no cleanup call.
    if settings.dns_provider != PROVIDER_HTTPREQ {
        return Ok(());
    }
    http.0
        .post(endpoint(settings, "cleanup"))
        .basic_auth(&settings.dns_username, Some(&settings.dns_password))
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(
            serde_json::json!({
                "fqdn": format!("_acme-challenge.{}.", record.domain),
                "value": record.value,
            })
            .to_string(),
        )
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)?;
    Ok(())
}

/// HTTP client for the ACME server and the DNS provider, trusting the system
/// roots plus the configured extra CA.
#[derive(Clone)]
struct AcmeHttp(reqwest::Client);

fn http_client(settings: &AcmeSettings::Model) -> Result<AcmeHttp> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
    if let Some(ca) = settings
        .ca_certificate_pem
        .as_deref()
        .filter(|ca| !ca.trim().is_empty())
    {
        for pem in Pem::iter_from_buffer(ca.as_bytes()) {
            let pem = pem.context("parsing the ACME CA certificate")?;
            builder = builder.add_root_certificate(
                reqwest::Certificate::from_der(&pem.contents)
                    .context("parsing the ACME CA certificate")?,
            );
        }
    }
    Ok(AcmeHttp(builder.build()?))
}

impl HttpClient for AcmeHttp {
    fn request(
        &self,
        req: http::Request<BodyWrapper<bytes::Bytes>>,
    ) -> Pin<Box<dyn Future<Output = Result<BytesResponse, instant_acme::Error>> + Send>> {
        let client = self.0.clone();
        Box::pin(async move {
            let request = reqwest::Request::try_from(req.map(reqwest::Body::wrap))
                .map_err(|error| instant_acme::Error::Other(Box::new(error)))?;
            let response = client
                .execute(request)
                .await
                .map_err(|error| instant_acme::Error::Other(Box::new(error)))?;
            Ok(BytesResponse::from(http::Response::<reqwest::Body>::from(
                response,
            )))
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::Datelike;

    use super::*;

    fn self_signed(names: &[&str], days: i64) -> String {
        let mut params = rcgen::CertificateParams::new(
            names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>(),
        )
        .expect("params");
        let not_after = (Utc::now() + chrono::Duration::days(days)).date_naive();
        params.not_after = rcgen::date_time_ymd(
            not_after.year(),
            u8::try_from(not_after.month()).expect("month"),
            u8::try_from(not_after.day()).expect("day"),
        );
        let key = rcgen::KeyPair::generate().expect("key");
        params.self_signed(&key).expect("cert").pem()
    }

    #[test]
    fn renewal_is_due_when_missing_expiring_or_for_other_domains() {
        let now = Utc::now();
        let domains = vec!["a.example.com".to_owned(), "*.a.example.com".to_owned()];
        assert!(renewal_due(None, &domains, now));

        let fresh = self_signed(&["*.a.example.com", "a.example.com"], 80);
        assert!(!renewal_due(Some(&fresh), &domains, now));

        let expiring = self_signed(&["a.example.com", "*.a.example.com"], 10);
        assert!(renewal_due(Some(&expiring), &domains, now));

        let other = self_signed(&["b.example.com"], 80);
        assert!(renewal_due(Some(&other), &domains, now));
    }
}
