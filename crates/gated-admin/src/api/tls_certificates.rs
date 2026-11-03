//! TLS certificates of gated's listeners and their ACME (DNS-01) issuance.

use axum::extract::Path;
use chrono::{DateTime, Utc};
use gated_common::web::{Data, Json};
use gated_common::{GatedError, api_response, api_routes};
use gated_core::Services;
use gated_core::acme;
use gated_core::tls_certificates::{self, InstallError, TlsListener};
use gated_db_entities::AcmeSettings;
use gated_tls::TlsCertificateBundle;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use super::AnySecurityScheme;
use super::upstream_certificate::{CertificateInfo, describe};

#[derive(Serialize, Deserialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TLSListener {
    Admin,
    Http,
    Mysql,
    Postgres,
}

impl From<TLSListener> for TlsListener {
    fn from(listener: TLSListener) -> Self {
        match listener {
            TLSListener::Admin => TlsListener::Admin,
            TLSListener::Http => TlsListener::Http,
            TLSListener::Mysql => TlsListener::Mysql,
            TLSListener::Postgres => TlsListener::Postgres,
        }
    }
}

impl From<TlsListener> for TLSListener {
    fn from(listener: TlsListener) -> Self {
        match listener {
            TlsListener::Admin => TLSListener::Admin,
            TlsListener::Http => TLSListener::Http,
            TlsListener::Mysql => TLSListener::Mysql,
            TlsListener::Postgres => TLSListener::Postgres,
        }
    }
}

#[derive(Serialize, ToSchema)]
struct AcmeStatus {
    domains: Vec<String>,
    last_attempt: Option<DateTime<Utc>>,
    last_success: Option<DateTime<Utc>>,
    last_error: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct ListenerCertificate {
    listener: TLSListener,
    /// Leaf first; empty until the listener has a certificate.
    chain: Vec<CertificateInfo>,
    created: Option<DateTime<Utc>>,
    /// Set when the certificate is issued and renewed through ACME.
    acme: Option<AcmeStatus>,
}

async fn describe_listener(
    services: &Services,
    listener: TlsListener,
) -> Result<ListenerCertificate, GatedError> {
    let current = tls_certificates::current(services, listener).await?;
    let chain = current
        .as_ref()
        .and_then(|cert| {
            TlsCertificateBundle::from_bytes(cert.certificate_pem.clone().into_bytes()).ok()
        })
        .map(|bundle| {
            bundle
                .certificates()
                .iter()
                .filter_map(|der| describe(der))
                .collect()
        })
        .unwrap_or_default();
    let acme = acme::load_listener(services, listener)
        .await?
        .map(|row| AcmeStatus {
            domains: acme::domains(&row),
            last_attempt: row.last_attempt,
            last_success: row.last_success,
            last_error: row.last_error,
        });
    Ok(ListenerCertificate {
        listener: listener.into(),
        chain,
        created: current.and_then(|cert| cert.created),
        acme,
    })
}

/// The admin listener has no certificate to manage when it serves plain HTTP.
async fn has_tls(services: &Services, listener: TlsListener) -> bool {
    listener != TlsListener::Admin || tls_certificates::admin_paths(services).await.is_some()
}

api_response! {
    enum GetTLSCertificatesResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ListenerCertificate>>),
    }
}

/// The certificate of each TLS listener (public parts only). The admin
/// listener is omitted when it serves plain HTTP.
#[utoipa::path(get, path = "/tls/certificates", operation_id = "get_tls_certificates")]
async fn api_get_tls_certificates(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetTLSCertificatesResponse, GatedError> {
    let mut result = Vec::new();
    for listener in TlsListener::ALL {
        if has_tls(&services, listener).await {
            result.push(describe_listener(&services, listener).await?);
        }
    }
    Ok(GetTLSCertificatesResponse::Ok(Json(result)))
}

api_response! {
    enum UpdateTLSCertificateResponse {
        #[oai(status = 200)]
        Ok(Json<ListenerCertificate>),

        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

const ADMIN_TLS_DISABLED: &str = "the admin listener has TLS disabled";

/// Replaces the listener's certificate with a new self-signed one and stops
/// ACME for it. Running listeners serve it to new connections.
#[utoipa::path(
    post,
    path = "/tls/certificates/{listener}/generate",
    operation_id = "generate_tls_certificate"
)]
async fn api_generate_tls_certificate(
    listener: Path<TLSListener>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<UpdateTLSCertificateResponse, GatedError> {
    let listener: TlsListener = listener.0.into();
    if !has_tls(&services, listener).await {
        return Ok(UpdateTLSCertificateResponse::BadRequest(Json(
            ADMIN_TLS_DISABLED.into(),
        )));
    }
    acme::disable(&services, listener).await?;
    tls_certificates::generate(&services, listener).await?;
    Ok(UpdateTLSCertificateResponse::Ok(Json(
        describe_listener(&services, listener).await?,
    )))
}

#[derive(Deserialize, ToSchema)]
struct ImportTLSCertificateRequest {
    /// PEM certificate chain, leaf first.
    certificate_pem: String,
    /// Unencrypted PEM private key of the leaf certificate.
    private_key_pem: String,
}

/// Stores a certificate and private key for the listener, replacing the
/// current one and stopping ACME for it. Running listeners serve it to new
/// connections.
#[utoipa::path(
    put,
    path = "/tls/certificates/{listener}",
    operation_id = "import_tls_certificate"
)]
async fn api_import_tls_certificate(
    listener: Path<TLSListener>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<ImportTLSCertificateRequest>,
) -> Result<UpdateTLSCertificateResponse, GatedError> {
    let listener: TlsListener = listener.0.into();
    if !has_tls(&services, listener).await {
        return Ok(UpdateTLSCertificateResponse::BadRequest(Json(
            ADMIN_TLS_DISABLED.into(),
        )));
    }
    match tls_certificates::install(
        &services,
        listener,
        body.certificate_pem.trim().to_owned(),
        body.private_key_pem.trim().to_owned(),
    )
    .await
    {
        Ok(()) => {}
        Err(error @ InstallError::Invalid(_)) => {
            return Ok(UpdateTLSCertificateResponse::BadRequest(Json(
                error.to_string(),
            )));
        }
        Err(InstallError::Other(error)) => return Err(error.into()),
    }
    acme::disable(&services, listener).await?;
    Ok(UpdateTLSCertificateResponse::Ok(Json(
        describe_listener(&services, listener).await?,
    )))
}

#[derive(Deserialize, ToSchema)]
struct EnableAcmeRequest {
    /// DNS names for the certificate; `*.example.com` requests a wildcard.
    domains: Vec<String>,
}

/// Issues the listener's certificate through ACME now and renews it
/// automatically. The domains are kept even if this attempt fails; the error
/// is returned and recorded on the listener.
#[utoipa::path(
    put,
    path = "/tls/certificates/{listener}/acme",
    operation_id = "enable_tls_acme"
)]
async fn api_enable_acme(
    listener: Path<TLSListener>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<EnableAcmeRequest>,
) -> Result<UpdateTLSCertificateResponse, GatedError> {
    let listener: TlsListener = listener.0.into();
    if !has_tls(&services, listener).await {
        return Ok(UpdateTLSCertificateResponse::BadRequest(Json(
            ADMIN_TLS_DISABLED.into(),
        )));
    }
    let mut domains: Vec<String> = body
        .domains
        .iter()
        .map(|domain| domain.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|domain| !domain.is_empty())
        .collect();
    domains.dedup();
    if domains.is_empty() {
        return Ok(UpdateTLSCertificateResponse::BadRequest(Json(
            "at least one domain is required".into(),
        )));
    }
    if acme::load_settings(&services).await?.is_none() {
        return Ok(UpdateTLSCertificateResponse::BadRequest(Json(
            "configure the ACME account and DNS provider first".into(),
        )));
    }
    if let Err(error) = acme::enable(&services, listener, domains).await {
        return Ok(UpdateTLSCertificateResponse::BadRequest(Json(format!(
            "{error:#}"
        ))));
    }
    Ok(UpdateTLSCertificateResponse::Ok(Json(
        describe_listener(&services, listener).await?,
    )))
}

api_response! {
    enum DisableAcmeResponse {
        #[oai(status = 204)]
        Disabled,
    }
}

/// Stops ACME issuance and renewal for the listener; its current certificate
/// stays in place.
#[utoipa::path(
    delete,
    path = "/tls/certificates/{listener}/acme",
    operation_id = "disable_tls_acme"
)]
async fn api_disable_acme(
    listener: Path<TLSListener>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DisableAcmeResponse, GatedError> {
    acme::disable(&services, listener.0.into()).await?;
    Ok(DisableAcmeResponse::Disabled)
}

#[derive(Serialize, Deserialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
enum AcmeDnsProvider {
    /// lego's httpreq protocol (`POST /present`, `/cleanup`).
    #[serde(rename = "httpreq")]
    HttpReq,
    /// An acme-dns server (`POST /update`).
    #[serde(rename = "acme-dns")]
    AcmeDns,
}

impl AcmeDnsProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::HttpReq => acme::PROVIDER_HTTPREQ,
            Self::AcmeDns => acme::PROVIDER_ACME_DNS,
        }
    }
}

#[derive(Serialize, ToSchema)]
struct AcmeSettingsResponse {
    /// False until the settings are saved for the first time.
    configured: bool,
    directory_url: String,
    contact_email: String,
    ca_certificate_pem: Option<String>,
    dns_provider: AcmeDnsProvider,
    dns_endpoint: String,
    dns_username: String,
    /// The password itself is never returned.
    dns_password_set: bool,
    dns_subdomain: String,
    propagation_delay_secs: i32,
}

impl From<Option<AcmeSettings::Model>> for AcmeSettingsResponse {
    fn from(settings: Option<AcmeSettings::Model>) -> Self {
        match settings {
            Some(s) => Self {
                configured: true,
                directory_url: s.directory_url,
                contact_email: s.contact_email,
                ca_certificate_pem: s.ca_certificate_pem,
                dns_provider: if s.dns_provider == acme::PROVIDER_ACME_DNS {
                    AcmeDnsProvider::AcmeDns
                } else {
                    AcmeDnsProvider::HttpReq
                },
                dns_endpoint: s.dns_endpoint,
                dns_username: s.dns_username,
                dns_password_set: !s.dns_password.is_empty(),
                dns_subdomain: s.dns_subdomain,
                propagation_delay_secs: s.propagation_delay_secs,
            },
            None => Self {
                configured: false,
                directory_url: "https://acme-v02.api.letsencrypt.org/directory".into(),
                contact_email: String::new(),
                ca_certificate_pem: None,
                dns_provider: AcmeDnsProvider::HttpReq,
                dns_endpoint: String::new(),
                dns_username: String::new(),
                dns_password_set: false,
                dns_subdomain: String::new(),
                propagation_delay_secs: 10,
            },
        }
    }
}

api_response! {
    enum GetAcmeSettingsResponse {
        #[oai(status = 200)]
        Ok(Json<AcmeSettingsResponse>),
    }
}

/// The ACME account and DNS provider used for every listener.
#[utoipa::path(get, path = "/tls/acme", operation_id = "get_acme_settings")]
async fn api_get_acme_settings(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetAcmeSettingsResponse, GatedError> {
    Ok(GetAcmeSettingsResponse::Ok(Json(
        acme::load_settings(&services).await?.into(),
    )))
}

#[derive(Deserialize, ToSchema)]
struct UpdateAcmeSettingsRequest {
    directory_url: String,
    contact_email: String,
    /// Extra trusted root (PEM) for a private ACME server or DNS endpoint.
    ca_certificate_pem: Option<String>,
    dns_provider: AcmeDnsProvider,
    dns_endpoint: String,
    dns_username: String,
    /// Omit to keep the stored password.
    dns_password: Option<String>,
    /// acme-dns only.
    #[serde(default)]
    dns_subdomain: String,
    propagation_delay_secs: i32,
}

api_response! {
    enum UpdateAcmeSettingsResponse {
        #[oai(status = 200)]
        Ok(Json<AcmeSettingsResponse>),

        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

/// Saves the ACME account and DNS provider. Changing the directory or contact
/// registers a new ACME account on the next issuance.
#[utoipa::path(put, path = "/tls/acme", operation_id = "update_acme_settings")]
async fn api_update_acme_settings(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<UpdateAcmeSettingsRequest>,
) -> Result<UpdateAcmeSettingsResponse, GatedError> {
    let body = body.0;
    let bad = |message: &str| Ok(UpdateAcmeSettingsResponse::BadRequest(Json(message.into())));
    let directory_url = body.directory_url.trim().to_owned();
    if !directory_url.starts_with("https://") {
        return bad("the ACME directory URL must use https://");
    }
    let dns_endpoint = body.dns_endpoint.trim().to_owned();
    if !(dns_endpoint.starts_with("https://") || dns_endpoint.starts_with("http://")) {
        return bad("the DNS provider endpoint must be an http(s) URL");
    }
    if !(0..=600).contains(&body.propagation_delay_secs) {
        return bad("the propagation delay must be between 0 and 600 seconds");
    }
    let dns_subdomain = body.dns_subdomain.trim().to_owned();
    if body.dns_provider == AcmeDnsProvider::AcmeDns && dns_subdomain.is_empty() {
        return bad("acme-dns needs the account's subdomain");
    }
    let ca_certificate_pem = body
        .ca_certificate_pem
        .map(|pem| pem.trim().to_owned())
        .filter(|pem| !pem.is_empty());
    if let Some(pem) = &ca_certificate_pem
        && TlsCertificateBundle::from_bytes(pem.clone().into_bytes()).is_err()
    {
        return bad("the CA certificate is not a PEM certificate");
    }

    let db = services.db_required().await?;
    let existing = AcmeSettings::Entity::find_by_id(1).one(&db).await?;
    let dns_password = match (body.dns_password.filter(|p| !p.is_empty()), &existing) {
        (Some(password), _) => password,
        (None, Some(existing)) if !existing.dns_password.is_empty() => {
            existing.dns_password.clone()
        }
        (None, _) => return bad("the DNS provider password is required"),
    };
    let contact_email = body.contact_email.trim().to_owned();
    let account_credentials = existing.as_ref().and_then(|existing| {
        (existing.directory_url == directory_url && existing.contact_email == contact_email)
            .then(|| existing.account_credentials.clone())
            .flatten()
    });
    let model = AcmeSettings::ActiveModel {
        id: Set(1),
        directory_url: Set(directory_url),
        contact_email: Set(contact_email),
        ca_certificate_pem: Set(ca_certificate_pem),
        dns_provider: Set(body.dns_provider.as_str().to_owned()),
        dns_endpoint: Set(dns_endpoint),
        dns_username: Set(body.dns_username.trim().to_owned()),
        dns_password: Set(dns_password),
        dns_subdomain: Set(dns_subdomain),
        propagation_delay_secs: Set(body.propagation_delay_secs),
        account_credentials: Set(account_credentials),
    };
    let saved = if existing.is_some() {
        model.update(&db).await?
    } else {
        model.insert(&db).await?
    };
    Ok(UpdateAcmeSettingsResponse::Ok(Json(Some(saved).into())))
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_tls_certificates,
        api_generate_tls_certificate,
        api_import_tls_certificate,
        api_enable_acme,
        api_disable_acme,
        api_get_acme_settings,
        api_update_acme_settings,
    )
}

#[cfg(test)]
mod tests {
    use gated_common::{GatedConfig, GlobalParams, Secret};

    use super::*;

    async fn test_services() -> Services {
        // `main` installs the provider in the real binary.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let root = std::env::temp_dir().join(format!("gated-tls-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").expect("write config");
        let mut config = GatedConfig {
            store: Default::default(),
        };
        config.store.database_url = Secret::new("sqlite:data/db".to_owned());
        let params = GlobalParams::new(config_path, false).expect("global params");
        let services = Services::new(config, None, params, None)
            .await
            .expect("services");
        services.open_db_legacy().await.expect("open db");
        services
    }

    fn served(services: &Services, listener: TlsListener) -> Vec<u8> {
        services
            .tls_resolvers
            .get(listener)
            .current()
            .expect("certificate")
            .cert[0]
            .to_vec()
    }

    async fn import(
        services: &Services,
        listener: TLSListener,
        certificate_pem: String,
        private_key_pem: String,
    ) -> UpdateTLSCertificateResponse {
        api_import_tls_certificate(
            Path(listener),
            Data(services.clone()),
            AnySecurityScheme,
            Json(ImportTLSCertificateRequest {
                certificate_pem,
                private_key_pem,
            }),
        )
        .await
        .expect("import")
    }

    #[tokio::test]
    async fn import_validates_and_swaps_the_served_certificate() {
        let services = test_services().await;
        tls_certificates::activate(&services, TlsListener::Mysql)
            .await
            .expect("activate");
        let generated = served(&services, TlsListener::Mysql);

        let a = rcgen::generate_simple_self_signed(vec!["db.example.com".to_owned()]).expect("a");
        let b = rcgen::generate_simple_self_signed(vec!["other".to_owned()]).expect("b");

        // A key from another certificate is refused and nothing changes.
        let response = import(
            &services,
            TLSListener::Mysql,
            a.cert.pem(),
            b.key_pair.serialize_pem(),
        )
        .await;
        assert!(matches!(
            response,
            UpdateTLSCertificateResponse::BadRequest(_)
        ));
        assert_eq!(served(&services, TlsListener::Mysql), generated);

        let response = import(
            &services,
            TLSListener::Mysql,
            a.cert.pem(),
            a.key_pair.serialize_pem(),
        )
        .await;
        let UpdateTLSCertificateResponse::Ok(Json(cert)) = response else {
            panic!("import refused");
        };
        assert_eq!(cert.chain[0].subject_alt_names, vec!["db.example.com"]);
        assert_eq!(served(&services, TlsListener::Mysql), a.cert.der().to_vec());
        // Other listeners are untouched.
        assert!(
            services
                .tls_resolvers
                .get(TlsListener::Http)
                .current()
                .is_none()
        );

        let GetTLSCertificatesResponse::Ok(Json(list)) =
            api_get_tls_certificates(Data(services.clone()), AnySecurityScheme)
                .await
                .expect("list");
        assert_eq!(list.len(), 3);
        assert!(list[0].chain.is_empty());
        assert_eq!(list[1].chain.len(), 1);

        // Regenerating replaces the imported certificate.
        api_generate_tls_certificate(
            Path(TLSListener::Mysql),
            Data(services.clone()),
            AnySecurityScheme,
        )
        .await
        .expect("generate");
        assert_ne!(served(&services, TlsListener::Mysql), a.cert.der().to_vec());

        services.close_db().await;
    }

    fn settings_request(password: Option<&str>, directory: &str) -> UpdateAcmeSettingsRequest {
        UpdateAcmeSettingsRequest {
            directory_url: directory.into(),
            contact_email: "ops@example.com".into(),
            ca_certificate_pem: None,
            dns_provider: AcmeDnsProvider::HttpReq,
            dns_endpoint: "https://api.dnsall.com".into(),
            dns_username: "user".into(),
            dns_password: password.map(str::to_owned),
            dns_subdomain: String::new(),
            propagation_delay_secs: 0,
        }
    }

    async fn update_settings(
        services: &Services,
        request: UpdateAcmeSettingsRequest,
    ) -> UpdateAcmeSettingsResponse {
        api_update_acme_settings(Data(services.clone()), AnySecurityScheme, Json(request))
            .await
            .expect("update settings")
    }

    #[tokio::test]
    async fn acme_settings_keep_the_password_and_reset_the_account_on_directory_change() {
        let services = test_services().await;
        let directory = "https://acme.example.com/dir";

        let response = update_settings(&services, settings_request(None, directory)).await;
        assert!(matches!(
            response,
            UpdateAcmeSettingsResponse::BadRequest(_)
        ));

        let response =
            update_settings(&services, settings_request(Some("secret"), directory)).await;
        let UpdateAcmeSettingsResponse::Ok(Json(saved)) = response else {
            panic!("settings refused");
        };
        assert!(saved.configured && saved.dns_password_set);

        // Pretend an account was registered.
        let db = services.db_required().await.expect("db");
        let mut row: AcmeSettings::ActiveModel = AcmeSettings::Entity::find_by_id(1)
            .one(&db)
            .await
            .expect("load")
            .expect("row")
            .into();
        row.account_credentials = Set(Some("{}".into()));
        row.update(&db).await.expect("update");

        update_settings(&services, settings_request(None, directory)).await;
        let row = acme::load_settings(&services)
            .await
            .expect("load")
            .expect("row");
        assert_eq!(row.dns_password, "secret");
        assert!(row.account_credentials.is_some());

        update_settings(
            &services,
            settings_request(None, "https://other.example.com/dir"),
        )
        .await;
        let row = acme::load_settings(&services)
            .await
            .expect("load")
            .expect("row");
        assert!(row.account_credentials.is_none());

        services.close_db().await;
    }

    #[tokio::test]
    async fn acme_requires_settings_and_a_manual_certificate_stops_it() {
        let services = test_services().await;
        let enable = |domains: Vec<&str>| {
            api_enable_acme(
                Path(TLSListener::Http),
                Data(services.clone()),
                AnySecurityScheme,
                Json(EnableAcmeRequest {
                    domains: domains.into_iter().map(str::to_owned).collect(),
                }),
            )
        };
        let response = enable(vec!["a.example.com"]).await.expect("enable");
        let UpdateTLSCertificateResponse::BadRequest(Json(message)) = response else {
            panic!("enabled without settings");
        };
        assert!(message.contains("configure"));

        // Issuance fails (nothing listens there) but the domains are kept and
        // the error is recorded.
        let mut request = settings_request(Some("secret"), "https://127.0.0.1:9/dir");
        request.dns_endpoint = "http://127.0.0.1:9".into();
        update_settings(&services, request).await;
        let response = enable(vec![" A.example.com. ", ""]).await.expect("enable");
        assert!(matches!(
            response,
            UpdateTLSCertificateResponse::BadRequest(_)
        ));
        let row = acme::load_listener(&services, TlsListener::Http)
            .await
            .expect("load")
            .expect("row");
        assert_eq!(acme::domains(&row), vec!["a.example.com"]);
        assert!(row.last_error.is_some());

        let cert = rcgen::generate_simple_self_signed(vec!["manual".to_owned()]).expect("cert");
        import(
            &services,
            TLSListener::Http,
            cert.cert.pem(),
            cert.key_pair.serialize_pem(),
        )
        .await;
        assert!(
            acme::load_listener(&services, TlsListener::Http)
                .await
                .expect("load")
                .is_none()
        );

        services.close_db().await;
    }
}
