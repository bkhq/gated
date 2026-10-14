use poem_openapi::{Object, Union};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Object, utoipa::ToSchema)]
pub struct SshPasswordAccountCredentials {
    pub username: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Object, utoipa::ToSchema)]
pub struct SshKeyAccountCredentials {
    pub username: String,
    pub private_key_pem: String,
    pub passphrase: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Object, utoipa::ToSchema)]
pub struct DbPasswordAccountCredentials {
    pub engine: DbPasswordEngine,
    pub username: String,
    pub password: String,
}

#[derive(
    Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, poem_openapi::Enum, utoipa::ToSchema,
)]
#[serde(rename_all = "kebab-case")]
#[oai(rename_all = "kebab-case")]
pub enum DbPasswordEngine {
    Mysql,
    Postgres,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Object, utoipa::ToSchema)]
pub struct K8sTokenAccountCredentials {
    pub token: String,
    pub ca_pem: Option<String>,
    pub namespace: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Object, utoipa::ToSchema)]
pub struct K8sClientCertAccountCredentials {
    pub client_certificate_pem: String,
    pub client_private_key_pem: String,
    pub passphrase: Option<String>,
    pub ca_pem: Option<String>,
    pub namespace: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Object, utoipa::ToSchema)]
pub struct HttpHeaderAccountCredential {
    pub name: String,
    pub value: String,
    pub sensitive: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Object, utoipa::ToSchema)]
pub struct HttpHeadersAccountCredentials {
    pub headers: Vec<HttpHeaderAccountCredential>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Union, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[oai(discriminator_name = "kind", one_of, rename_all = "kebab-case")]
pub enum AccountCredentials {
    #[serde(rename = "ssh-password")]
    #[oai(mapping = "ssh-password")]
    SshPassword(SshPasswordAccountCredentials),
    #[serde(rename = "ssh-key")]
    #[oai(mapping = "ssh-key")]
    SshKey(SshKeyAccountCredentials),
    #[serde(rename = "db-password")]
    #[oai(mapping = "db-password")]
    DbPassword(DbPasswordAccountCredentials),
    #[serde(rename = "k8s-token")]
    #[oai(mapping = "k8s-token")]
    K8sToken(K8sTokenAccountCredentials),
    #[serde(rename = "k8s-client-cert")]
    #[oai(mapping = "k8s-client-cert")]
    K8sClientCert(K8sClientCertAccountCredentials),
    #[serde(rename = "http-headers")]
    #[oai(mapping = "http-headers")]
    HttpHeaders(HttpHeadersAccountCredentials),
}

impl AccountCredentials {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::SshPassword(_) => "ssh-password",
            Self::SshKey(_) => "ssh-key",
            Self::DbPassword(_) => "db-password",
            Self::K8sToken(_) => "k8s-token",
            Self::K8sClientCert(_) => "k8s-client-cert",
            Self::HttpHeaders(_) => "http-headers",
        }
    }
}
