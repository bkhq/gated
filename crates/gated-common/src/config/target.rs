use std::collections::HashMap;

use gated_tls::TlsMode;
use poem_openapi::{Enum, Object, Union};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::defaults::*;
use crate::Secret;

#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct TargetSSHOptions {
    pub host: String,
    #[serde(default = "_default_ssh_port")]
    pub port: u16,
    #[serde(default = "_default_username")]
    pub username: String,
    #[serde(default)]
    pub allow_insecure_algos: Option<bool>,
    #[serde(default)]
    pub auth: SSHTargetAuth,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Union)]
#[serde(untagged)]
#[oai(discriminator_name = "kind", one_of)]
pub enum SSHTargetAuth {
    #[serde(rename = "password")]
    Password(SshTargetPasswordAuth),
    #[serde(rename = "publickey")]
    PublicKey(SshTargetPublicKeyAuth),
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct SshTargetPasswordAuth {
    pub password: Secret<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object, Default)]
pub struct SshTargetPublicKeyAuth {
    #[serde(default)]
    pub private_key_pem: Option<Secret<String>>,
    #[serde(default)]
    pub passphrase: Option<Secret<String>>,
}

impl Default for SSHTargetAuth {
    fn default() -> Self {
        SSHTargetAuth::PublicKey(SshTargetPublicKeyAuth::default())
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct Tls {
    #[serde(default)]
    pub mode: TlsMode,

    #[serde(default = "_default_true")]
    pub verify: bool,
}

impl Default for Tls {
    fn default() -> Self {
        Self {
            mode: TlsMode::default(),
            verify: true,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct TargetMySqlOptions {
    #[serde(default = "_default_empty_string")]
    pub host: String,

    #[serde(default = "_default_mysql_port")]
    pub port: u16,

    #[serde(default = "_default_username")]
    pub username: String,

    #[serde(default)]
    pub password: Option<String>,

    #[serde(default)]
    pub tls: Tls,

    #[serde(default)]
    pub default_database_name: Option<String>,

    /// When true, the SQL Console rejects anything not starting with
    /// SELECT / SHOW / EXPLAIN / WITH. This is convenience-level only —
    /// use a real read-only DB user for hard guarantees.
    #[serde(default)]
    pub readonly: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct TargetPostgresOptions {
    #[serde(default = "_default_empty_string")]
    pub host: String,

    #[serde(default = "_default_mysql_port")]
    pub port: u16,

    #[serde(default = "_default_username")]
    pub username: String,

    #[serde(default)]
    pub password: Option<String>,

    #[serde(default)]
    pub tls: Tls,

    #[serde(default = "_default_postgres_idle_timeout_str")]
    pub idle_timeout: Option<String>,

    #[serde(default)]
    pub default_database_name: Option<String>,

    /// See `TargetMySqlOptions::readonly`.
    #[serde(default)]
    pub readonly: bool,
}

/// Unified HTTP-reverse-proxy target.  Replaces the old `TargetApiOptions`
/// and `TargetKubernetesOptions`.  `flavor` toggles Kubernetes-specific
/// behaviour (channel.k8s.io WebSocket, watch streaming, exec/attach
/// recording enrichment).
#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct TargetHttpOptions {
    /// Upstream base URL (e.g. `https://kubernetes.example.com` for K8s,
    /// or any http(s) origin for generic targets).
    #[serde(default = "_default_empty_string")]
    pub url: String,

    /// TLS settings for the upstream connection. `tls.verify` defaults to
    /// `true`; set it to `false` only for a target with a self-signed or
    /// otherwise unverifiable cert.
    #[serde(default)]
    pub tls: Tls,

    /// Optional PEM bundle of CA certificates trusted for the upstream
    /// connection (e.g. an in-cluster signing CA).
    #[serde(default)]
    pub ca_certificate: Option<Secret<String>>,

    /// How Gated authenticates to the upstream service.
    #[serde(default)]
    pub upstream_auth: UpstreamAuth,

    /// Protocol-level behaviours unlocked for this target.
    #[serde(default)]
    pub flavor: HttpProxyFlavor,
}

impl Default for TargetHttpOptions {
    fn default() -> Self {
        Self {
            url: String::new(),
            tls: Tls::default(),
            ca_certificate: None,
            upstream_auth: UpstreamAuth::default(),
            flavor: HttpProxyFlavor::default(),
        }
    }
}

/// Empty marker for the `none` variant of [`UpstreamAuth`].
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object, Default)]
#[serde(deny_unknown_fields)]
pub struct NoUpstreamAuth {}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct HeadersUpstreamAuth {
    pub headers: HashMap<String, Secret<String>>,
}

impl Default for HeadersUpstreamAuth {
    fn default() -> Self {
        Self {
            headers: HashMap::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct BearerTokenUpstreamAuth {
    pub token: Secret<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct ClientCertificateUpstreamAuth {
    pub certificate: Secret<String>,
    pub private_key: Secret<String>,
}

impl Default for ClientCertificateUpstreamAuth {
    fn default() -> Self {
        Self {
            certificate: Secret::new(String::new()),
            private_key: Secret::new(String::new()),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Union)]
#[serde(untagged)]
#[oai(discriminator_name = "kind", one_of)]
pub enum UpstreamAuth {
    #[serde(rename = "none")]
    None(NoUpstreamAuth),
    #[serde(rename = "headers")]
    Headers(HeadersUpstreamAuth),
    #[serde(rename = "bearer_token")]
    BearerToken(BearerTokenUpstreamAuth),
    #[serde(rename = "client_certificate")]
    ClientCertificate(ClientCertificateUpstreamAuth),
}

impl Default for UpstreamAuth {
    fn default() -> Self {
        UpstreamAuth::None(NoUpstreamAuth {})
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Enum, Default)]
#[serde(rename_all = "lowercase")]
#[oai(rename_all = "lowercase")]
pub enum HttpProxyFlavor {
    #[default]
    Generic,
    Kubernetes,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Enum)]
#[serde(rename_all = "kebab-case")]
#[oai(rename_all = "kebab-case")]
pub enum TargetAccountRole {
    Primary,
    Fallback,
    Readonly,
}

impl TargetAccountRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Fallback => "fallback",
            Self::Readonly => "readonly",
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct TargetAccountMetadata {
    pub account_id: i32,
    pub account_name: String,
    pub kind: String,
    pub role: TargetAccountRole,
}

#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct Target {
    #[serde(default)]
    pub id: Uuid,
    pub name: String,
    pub description: String,
    #[serde(default = "_default_empty_vec")]
    pub allow_roles: Vec<String>,
    #[serde(flatten)]
    pub options: TargetOptions,
    #[serde(default = "_default_empty_vec")]
    pub accounts: Vec<TargetAccountMetadata>,
    pub rate_limit_bytes_per_second: Option<u32>,
    pub group_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Union)]
#[oai(discriminator_name = "kind", one_of)]
pub enum TargetOptions {
    #[serde(rename = "ssh")]
    Ssh(TargetSSHOptions),
    #[serde(rename = "http")]
    Http(TargetHttpOptions),
    #[serde(rename = "mysql")]
    MySql(TargetMySqlOptions),
    #[serde(rename = "postgres")]
    Postgres(TargetPostgresOptions),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_auth_survives_database_json_roundtrip() {
        for auth in [
            UpstreamAuth::None(NoUpstreamAuth {}),
            UpstreamAuth::Headers(HeadersUpstreamAuth {
                headers: [("X-Auth".into(), Secret::new("header-value".into()))].into(),
            }),
            UpstreamAuth::BearerToken(BearerTokenUpstreamAuth {
                token: Secret::new("token-value".into()),
            }),
            UpstreamAuth::ClientCertificate(ClientCertificateUpstreamAuth {
                certificate: Secret::new("certificate".into()),
                private_key: Secret::new("private-key".into()),
            }),
        ] {
            let json = serde_json::to_value(&auth).unwrap();
            let restored: UpstreamAuth = serde_json::from_value(json).unwrap();
            assert_eq!(restored, auth);
        }
    }

    #[test]
    fn tls_defaults_are_fail_safe() {
        // Verify on, TLS required by default.
        let tls = Tls::default();
        assert!(tls.verify);
        assert_eq!(tls.mode, TlsMode::Required);
    }

    #[test]
    fn tls_serde_defaults_match_struct_default() {
        // An empty `tls` object must deserialize to the fail-safe defaults,
        // not to the field types' own defaults (bool=false / first enum).
        let tls: Tls = serde_json::from_str("{}").unwrap();
        assert!(tls.verify);
        assert_eq!(tls.mode, TlsMode::Required);
    }

    #[test]
    fn tls_explicit_verify_false_is_honored() {
        let tls: Tls = serde_json::from_str(r#"{"verify": false}"#).unwrap();
        assert!(!tls.verify);
    }
}
