//! TLS certificates of the HTTP proxy, MySQL and PostgreSQL listeners.

use axum::extract::Path;
use chrono::{DateTime, Utc};
use gated_common::web::{Data, Json};
use gated_common::{GatedError, api_response, api_routes};
use gated_core::Services;
use gated_core::tls_certificates::{self, TlsListener};
use gated_db_entities::TlsCertificate;
use gated_tls::TlsCertificateAndPrivateKey;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use super::AnySecurityScheme;
use super::upstream_certificate::{CertificateInfo, describe};

#[derive(Serialize, Deserialize, ToSchema, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
enum TLSListener {
    Http,
    Mysql,
    Postgres,
}

impl From<TLSListener> for TlsListener {
    fn from(listener: TLSListener) -> Self {
        match listener {
            TLSListener::Http => TlsListener::Http,
            TLSListener::Mysql => TlsListener::Mysql,
            TLSListener::Postgres => TlsListener::Postgres,
        }
    }
}

impl From<TlsListener> for TLSListener {
    fn from(listener: TlsListener) -> Self {
        match listener {
            TlsListener::Http => TLSListener::Http,
            TlsListener::Mysql => TLSListener::Mysql,
            TlsListener::Postgres => TLSListener::Postgres,
        }
    }
}

#[derive(Serialize, ToSchema)]
struct ListenerCertificate {
    listener: TLSListener,
    /// Leaf first; empty until the listener has a certificate.
    chain: Vec<CertificateInfo>,
    created: Option<DateTime<Utc>>,
}

fn describe_row(listener: TlsListener, row: Option<&TlsCertificate::Model>) -> ListenerCertificate {
    let chain = row
        .and_then(|row| tls_certificates::parse(row).ok())
        .map(|pair| {
            pair.certificate
                .certificates()
                .iter()
                .filter_map(|der| describe(der))
                .collect()
        })
        .unwrap_or_default();
    ListenerCertificate {
        listener: listener.into(),
        chain,
        created: row.map(|row| row.created),
    }
}

api_response! {
    enum GetTLSCertificatesResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<ListenerCertificate>>),
    }
}

/// The certificate of each TLS listener (public parts only).
#[utoipa::path(get, path = "/tls/certificates", operation_id = "get_tls_certificates")]
async fn api_get_tls_certificates(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetTLSCertificatesResponse, GatedError> {
    let db = services.db_required().await?;
    let mut result = Vec::new();
    for listener in TlsListener::ALL {
        let row = tls_certificates::load(&db, listener).await?;
        result.push(describe_row(listener, row.as_ref()));
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

/// Replaces the listener's certificate with a new self-signed one. Running
/// listeners serve it to new connections.
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
    let db = services.db_required().await?;
    let external_host = services.config.read().await.store.external_host.clone();
    let row = tls_certificates::generate(&db, listener, external_host.as_deref()).await?;
    let pair = tls_certificates::parse(&row).map_err(GatedError::other)?;
    services.tls_resolvers.get(listener).set(pair);
    Ok(UpdateTLSCertificateResponse::Ok(Json(describe_row(
        listener,
        Some(&row),
    ))))
}

#[derive(Deserialize, ToSchema)]
struct ImportTLSCertificateRequest {
    /// PEM certificate chain, leaf first.
    certificate_pem: String,
    /// Unencrypted PEM private key of the leaf certificate.
    private_key_pem: String,
}

/// Stores a certificate and private key for the listener, replacing the
/// current one. Running listeners serve it to new connections.
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
    let certificate_pem = body.certificate_pem.trim().to_owned();
    let private_key_pem = body.private_key_pem.trim().to_owned();
    let pair = match TlsCertificateAndPrivateKey::from_pem(
        certificate_pem.as_bytes(),
        private_key_pem.as_bytes(),
    ) {
        Ok(pair) => pair,
        Err(error) => {
            return Ok(UpdateTLSCertificateResponse::BadRequest(Json(format!(
                "invalid certificate or key: {error}"
            ))));
        }
    };
    let db = services.db_required().await?;
    let row = tls_certificates::save(&db, listener, certificate_pem, private_key_pem).await?;
    services.tls_resolvers.get(listener).set(pair);
    Ok(UpdateTLSCertificateResponse::Ok(Json(describe_row(
        listener,
        Some(&row),
    ))))
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_tls_certificates,
        api_generate_tls_certificate,
        api_import_tls_certificate,
    )
}

#[cfg(test)]
mod tests {
    use gated_common::{GatedConfig, GlobalParams, Secret};

    use super::*;

    async fn test_services() -> Services {
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
}
