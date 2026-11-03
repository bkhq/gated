use sea_orm::entity::prelude::*;

/// The single ACME account and DNS provider configuration (`id = 1`).
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "acme_settings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i32,
    pub directory_url: String,
    pub contact_email: String,
    /// Extra trusted root for a private ACME server and DNS endpoint.
    #[sea_orm(column_type = "Text", nullable)]
    pub ca_certificate_pem: Option<String>,
    /// `httpreq` or `acme-dns`.
    pub dns_provider: String,
    pub dns_endpoint: String,
    pub dns_username: String,
    #[sea_orm(column_type = "Text")]
    pub dns_password: String,
    /// acme-dns subdomain; unused by httpreq.
    pub dns_subdomain: String,
    pub propagation_delay_secs: i32,
    /// Serialized `instant_acme::AccountCredentials`, created on first use.
    #[sea_orm(column_type = "Text", nullable)]
    pub account_credentials: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
