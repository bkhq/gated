mod defaults;
mod target;

use std::ops::Deref;
use std::path::PathBuf;
use std::time::Duration;

use defaults::*;
use gated_sso::SsoProviderConfig;
use gated_tls::IntoTlsCertificateRelativePaths;
use poem::http::uri;
use poem_openapi::{Object, Union};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub use target::*;
use tracing::warn;
use uri::Scheme;
use url::Url;
use uuid::Uuid;

use crate::auth::CredentialKind;
use crate::helpers::hash::hash_password;
use crate::helpers::otp::OtpSecretKey;
use crate::{GatedError, ListenEndpoint, Secret};

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Union)]
#[serde(tag = "type")]
#[oai(discriminator_name = "kind", one_of)]
pub enum UserAuthCredential {
    #[serde(rename = "password")]
    Password(UserPasswordCredential),
    #[serde(rename = "publickey")]
    PublicKey(UserPublicKeyCredential),
    #[serde(rename = "certificate")]
    Certificate(UserCertificateCredential),
    #[serde(rename = "otp")]
    Totp(UserTotpCredential),
    #[serde(rename = "sso")]
    Sso(UserSsoCredential),
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct UserPasswordCredential {
    pub hash: Secret<String>,
}

impl UserPasswordCredential {
    pub fn from_password(password: &Secret<String>) -> Self {
        Self {
            hash: Secret::new(hash_password(password.expose_secret())),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct UserPublicKeyCredential {
    pub key: Secret<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct UserCertificateCredential {
    pub certificate_pem: Secret<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct UserTotpCredential {
    #[serde(with = "crate::helpers::serde_base64_secret")]
    pub key: OtpSecretKey,
}
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Object)]
pub struct UserSsoCredential {
    pub provider: Option<String>,
    pub email: String,
    /// OIDC issuer (`iss`) claim. `None` for manually-provisioned
    /// credentials; populated for credentials created via an OIDC login.
    #[serde(default)]
    pub iss: Option<String>,
    /// OIDC subject (`sub`) claim. `None` for manually-provisioned
    /// credentials; populated for credentials created via an OIDC login.
    #[serde(default)]
    pub sub: Option<String>,
}

impl UserAuthCredential {
    pub fn kind(&self) -> CredentialKind {
        match self {
            Self::Password(_) => CredentialKind::Password,
            Self::PublicKey(_) => CredentialKind::PublicKey,
            Self::Certificate(_) => CredentialKind::Certificate,
            Self::Totp(_) => CredentialKind::Totp,
            Self::Sso(_) => CredentialKind::Sso,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Object, Default)]
pub struct UserRequireCredentialsPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<Vec<CredentialKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kubernetes: Option<Vec<CredentialKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<Vec<CredentialKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mysql: Option<Vec<CredentialKind>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postgres: Option<Vec<CredentialKind>>,
}

impl UserRequireCredentialsPolicy {
    #[must_use]
    pub fn upgrade_to_otp(&self, with_existing_credentials: &[UserAuthCredential]) -> Self {
        let mut copy = self.clone();

        if let Some(policy) = &mut copy.http {
            policy.push(CredentialKind::Totp);
        } else {
            // Upgrade to OTP only if there is a password credential
            let mut kinds = vec![];
            if with_existing_credentials
                .iter()
                .any(|c| c.kind() == CredentialKind::Password)
            {
                kinds.push(CredentialKind::Password);
            }
            if !kinds.is_empty() {
                kinds.push(CredentialKind::Totp);
                copy.http = Some(kinds);
            }
        }

        if let Some(policy) = &mut copy.ssh {
            policy.push(CredentialKind::Totp);
        } else {
            // Upgrade to OTP only if there is a password or public key credential
            let mut kinds = vec![];
            if with_existing_credentials.iter().any(|c| {
                c.kind() == CredentialKind::Password || c.kind() == CredentialKind::PublicKey
            }) {
                kinds.push(CredentialKind::Password);
            }
            if !kinds.is_empty() {
                kinds.push(CredentialKind::Totp);
                copy.ssh = Some(kinds);
            }
        }
        copy
    }

    /// Remove OTP requirement from all protocol policies.
    /// Returns `None` if the resulting policy is empty (all protocols default).
    #[must_use]
    pub fn downgrade_from_otp(&self) -> Option<Self> {
        let mut copy = self.clone();

        fn remove_otp(kinds: &mut Vec<CredentialKind>) {
            kinds.retain(|k| *k != CredentialKind::Totp);
        }

        if let Some(ref mut policy) = copy.http {
            remove_otp(policy);
            if policy.is_empty() {
                copy.http = None;
            }
        }
        if let Some(ref mut policy) = copy.ssh {
            remove_otp(policy);
            if policy.is_empty() {
                copy.ssh = None;
            }
        }
        if let Some(ref mut policy) = copy.kubernetes {
            remove_otp(policy);
            if policy.is_empty() {
                copy.kubernetes = None;
            }
        }
        if let Some(ref mut policy) = copy.mysql {
            remove_otp(policy);
            if policy.is_empty() {
                copy.mysql = None;
            }
        }
        if let Some(ref mut policy) = copy.postgres {
            remove_otp(policy);
            if policy.is_empty() {
                copy.postgres = None;
            }
        }

        if copy.http.is_none()
            && copy.ssh.is_none()
            && copy.kubernetes.is_none()
            && copy.mysql.is_none()
            && copy.postgres.is_none()
        {
            None
        } else {
            Some(copy)
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct User {
    #[serde(default)]
    pub id: Uuid,
    pub username: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "require")]
    pub credential_policy: Option<UserRequireCredentialsPolicy>,
    pub rate_limit_bytes_per_second: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Object)]
pub struct UserDetails {
    pub inner: User,
    pub credentials: Vec<UserAuthCredential>,
    pub roles: Vec<String>,
}

impl Deref for UserDetails {
    type Target = User;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Hash, Object)]
pub struct Role {
    #[serde(default)]
    pub id: Uuid,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default, PartialEq, Eq, Copy, JsonSchema)]
pub enum SshHostKeyVerificationMode {
    #[serde(rename = "prompt")]
    Prompt,
    #[serde(rename = "auto_accept")]
    AutoAccept,
    #[serde(rename = "auto_reject")]
    #[default]
    AutoReject,
}

#[derive(
    Debug, Deserialize, Serialize, Clone, Copy, Default, PartialEq, Eq, JsonSchema, clap::ValueEnum,
)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    #[default]
    Text,
    Json,
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct SshConfig {
    #[serde(default = "_default_false")]
    pub enable: bool,

    #[serde(default = "_default_ssh_listen")]
    pub listen: ListenEndpoint,

    #[serde(default)]
    pub external_port: Option<u16>,

    #[serde(default = "_default_ssh_keys_path")]
    pub keys: String,

    #[serde(default)]
    pub host_key_verification: SshHostKeyVerificationMode,

    #[serde(default = "_default_ssh_inactivity_timeout", with = "humantime_serde")]
    #[schemars(with = "String")]
    pub inactivity_timeout: Duration,

    #[serde(default)]
    pub keepalive_interval: Option<Duration>,
}

impl Default for SshConfig {
    fn default() -> Self {
        SshConfig {
            enable: false,
            listen: _default_ssh_listen(),
            keys: _default_ssh_keys_path(),
            host_key_verification: Default::default(),
            external_port: None,
            inactivity_timeout: _default_ssh_inactivity_timeout(),
            keepalive_interval: None,
        }
    }
}

impl SshConfig {
    pub fn external_port(&self) -> u16 {
        self.external_port.unwrap_or(self.listen.port())
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct SniCertificateConfig {
    pub certificate: String,
    pub key: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct HttpConfig {
    #[serde(default = "_default_http_listen")]
    pub listen: ListenEndpoint,

    #[serde(default)]
    pub external_port: Option<u16>,

    #[serde(default)]
    pub certificate: String,

    #[serde(default)]
    pub key: String,

    #[serde(default)]
    pub trust_x_forwarded_headers: bool,

    #[serde(default = "_default_true")]
    pub tls: bool,

    #[serde(default = "_default_session_max_age", with = "humantime_serde")]
    #[schemars(with = "String")]
    pub session_max_age: Duration,

    #[serde(default = "_default_cookie_max_age", with = "humantime_serde")]
    #[schemars(with = "String")]
    pub cookie_max_age: Duration,

    #[serde(default)]
    pub cookie_domain: Option<String>,

    #[serde(default)]
    pub sni_certificates: Vec<SniCertificateConfig>,
}

impl Default for HttpConfig {
    fn default() -> Self {
        HttpConfig {
            listen: _default_http_listen(),
            external_port: None,
            certificate: "".to_owned(),
            key: "".to_owned(),
            trust_x_forwarded_headers: false,
            tls: true,
            session_max_age: _default_session_max_age(),
            cookie_max_age: _default_cookie_max_age(),
            cookie_domain: None,
            sni_certificates: vec![],
        }
    }
}

impl HttpConfig {
    pub fn external_port(&self) -> u16 {
        self.external_port.unwrap_or(self.listen.port())
    }
}

impl IntoTlsCertificateRelativePaths for HttpConfig {
    fn certificate_path(&self) -> PathBuf {
        self.certificate.as_str().into()
    }

    fn key_path(&self) -> PathBuf {
        self.key.as_str().into()
    }
}

impl IntoTlsCertificateRelativePaths for SniCertificateConfig {
    fn certificate_path(&self) -> PathBuf {
        self.certificate.as_str().into()
    }

    fn key_path(&self) -> PathBuf {
        self.key.as_str().into()
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct MySqlConfig {
    #[serde(default = "_default_false")]
    pub enable: bool,

    #[serde(default = "_default_mysql_listen")]
    pub listen: ListenEndpoint,

    #[serde(default)]
    pub external_port: Option<u16>,

    #[serde(default)]
    pub certificate: String,

    #[serde(default)]
    pub key: String,
}

impl Default for MySqlConfig {
    fn default() -> Self {
        MySqlConfig {
            enable: false,
            listen: _default_mysql_listen(),
            external_port: None,
            certificate: "".to_owned(),
            key: "".to_owned(),
        }
    }
}

impl MySqlConfig {
    pub fn external_port(&self) -> u16 {
        self.external_port.unwrap_or(self.listen.port())
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct ProxyConfig {
    #[serde(default = "_default_false")]
    pub enable: bool,

    #[serde(default = "_default_proxy_listen")]
    pub listen: ListenEndpoint,

    #[serde(default)]
    pub external_port: Option<u16>,

    #[serde(default)]
    pub certificate: String,

    #[serde(default)]
    pub key: String,

    #[serde(default = "_default_session_max_age", with = "humantime_serde")]
    #[schemars(with = "String")]
    pub session_max_age: Duration,

    /// When false, serve the proxy listener as plaintext HTTP so a
    /// TLS-terminating reverse proxy in front (Traefik / nsl) handles TLS.
    /// When true (default), terminate TLS here using `certificate`/`key`.
    /// Mirrors `http.tls`.
    #[serde(default = "_default_true")]
    pub tls: bool,

    /// Acknowledges that a trusted TLS-terminating reverse proxy sits in front
    /// of this listener. Required to bind a non-loopback address while
    /// `tls = false`; without it, a plaintext listener refuses any
    /// non-loopback bind so `?gated-token=` and upstream traffic cannot leave
    /// the host in cleartext. Has no effect when `tls = true`.
    #[serde(default = "_default_false")]
    pub behind_proxy: bool,

    /// Wildcard base domain for Host-based target resolution.
    /// A request whose `Host` header shapes as `<target.name>.<base_domain>`
    /// resolves to the target named `<target.name>`.  Leave empty to force
    /// every request to provide an `X-Gated-Target` header.
    #[serde(default)]
    pub base_domain: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        ProxyConfig {
            enable: false,
            listen: _default_proxy_listen(),
            external_port: None,
            certificate: "".to_owned(),
            key: "".to_owned(),
            session_max_age: _default_session_max_age(),
            tls: true,
            behind_proxy: false,
            base_domain: "".to_owned(),
        }
    }
}

impl ProxyConfig {
    pub fn external_port(&self) -> u16 {
        self.external_port.unwrap_or(self.listen.port())
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct PostgresConfig {
    #[serde(default = "_default_false")]
    pub enable: bool,

    #[serde(default = "_default_postgres_listen")]
    pub listen: ListenEndpoint,

    #[serde(default)]
    pub external_port: Option<u16>,

    #[serde(default)]
    pub certificate: String,

    #[serde(default)]
    pub key: String,
}

impl Default for PostgresConfig {
    fn default() -> Self {
        PostgresConfig {
            enable: false,
            listen: _default_postgres_listen(),
            external_port: None,
            certificate: "".to_owned(),
            key: "".to_owned(),
        }
    }
}

impl PostgresConfig {
    pub fn external_port(&self) -> u16 {
        self.external_port.unwrap_or(self.listen.port())
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct RecordingsConfig {
    #[serde(default = "_default_false")]
    pub enable: bool,

    #[serde(default = "_default_recordings_path")]
    pub path: String,
}

impl Default for RecordingsConfig {
    fn default() -> Self {
        Self {
            enable: false,
            path: _default_recordings_path(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct LogConfig {
    #[serde(default = "_default_retention", with = "humantime_serde")]
    #[schemars(with = "String")]
    pub retention: Duration,

    #[serde(default = "_default_retention", with = "humantime_serde")]
    #[schemars(with = "String")]
    pub management_retention: Duration,

    #[serde(default)]
    pub send_to: Option<String>,

    #[serde(default)]
    pub format: LogFormat,

    /// Default tracing filter directive (e.g. `info`, `gated=debug,russh=info`).
    /// Falls back to the `RUST_LOG` env var / `-d` CLI flag when unset.
    #[serde(default)]
    pub level: Option<String>,

    /// Console sink overrides.
    #[serde(default)]
    pub console: LogConsoleConfig,

    /// Optional rolling-file sink.
    #[serde(default)]
    pub file: LogFileConfig,

    /// Optional OpenTelemetry OTLP exporter. When absent, no traces/logs are
    /// exported over OTLP.
    #[serde(default)]
    pub otlp: Option<LogOtlpConfig>,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            retention: _default_retention(),
            management_retention: _default_retention(),
            send_to: None,
            format: LogFormat::default(),
            level: None,
            console: LogConsoleConfig::default(),
            file: LogFileConfig::default(),
            otlp: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Default, JsonSchema)]
pub struct LogConsoleConfig {
    /// Per-sink filter override. Falls back to `log.level` when unset.
    #[serde(default)]
    pub level: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LogFileRotation {
    #[default]
    Daily,
    Hourly,
    Minutely,
    Never,
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct LogFileConfig {
    /// Enable file logging.
    #[serde(default)]
    pub enable: bool,

    /// Directory for log files. Relative paths resolve against the config dir.
    #[serde(default)]
    pub directory: Option<PathBuf>,

    /// Base file name (rotation suffixes are appended by `tracing-appender`).
    #[serde(default = "_default_log_file_prefix")]
    pub prefix: String,

    /// Rotation cadence.
    #[serde(default)]
    pub rotation: LogFileRotation,

    /// Per-sink filter override. Falls back to `log.level` when unset.
    #[serde(default)]
    pub level: Option<String>,

    /// Output format for this sink. Falls back to `log.format` when unset.
    #[serde(default)]
    pub format: Option<LogFormat>,
}

impl Default for LogFileConfig {
    fn default() -> Self {
        Self {
            enable: false,
            directory: None,
            prefix: _default_log_file_prefix(),
            rotation: LogFileRotation::default(),
            level: None,
            format: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OtlpProtocol {
    #[default]
    Grpc,
    HttpProtobuf,
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct LogOtlpConfig {
    /// OTLP endpoint (e.g. `http://otel-collector:4317` for gRPC,
    /// `http://otel-collector:4318/v1/traces` for HTTP).
    pub endpoint: String,

    /// Wire protocol.
    #[serde(default)]
    pub protocol: OtlpProtocol,

    /// Service name reported to the collector.
    #[serde(default = "_default_otlp_service_name")]
    pub service_name: String,

    /// Optional headers (e.g. auth tokens) added to every export request.
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,

    /// Per-sink filter override. Falls back to `log.level` when unset.
    #[serde(default)]
    pub level: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct MetricsConfig {
    #[serde(default = "_default_false")]
    pub enable: bool,

    #[serde(default = "_default_metrics_listen")]
    pub listen: ListenEndpoint,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            enable: false,
            listen: _default_metrics_listen(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Default, JsonSchema)]
pub struct EncryptionConfig {
    #[serde(default)]
    pub enable: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, JsonSchema)]
pub struct GatedConfigStore {
    #[serde(default)]
    pub sso_providers: Vec<SsoProviderConfig>,

    #[serde(default)]
    pub recordings: RecordingsConfig,

    #[serde(default)]
    pub external_host: Option<String>,

    #[serde(default = "_default_database_url")]
    #[schemars(with = "String")]
    pub database_url: Secret<String>,

    #[serde(default)]
    pub ssh: SshConfig,

    #[serde(default)]
    pub http: HttpConfig,

    #[serde(default)]
    pub proxy: ProxyConfig,

    #[serde(default)]
    pub mysql: MySqlConfig,

    #[serde(default)]
    pub postgres: PostgresConfig,

    #[serde(default)]
    pub metrics: MetricsConfig,

    #[serde(default)]
    pub encryption: EncryptionConfig,

    #[serde(default)]
    pub log: LogConfig,
}

impl Default for GatedConfigStore {
    fn default() -> Self {
        Self {
            sso_providers: vec![],
            recordings: <_>::default(),
            external_host: None,
            database_url: _default_database_url(),
            ssh: <_>::default(),
            http: <_>::default(),
            proxy: <_>::default(),
            mysql: <_>::default(),
            postgres: <_>::default(),
            metrics: <_>::default(),
            encryption: <_>::default(),
            log: <_>::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GatedConfig {
    pub store: GatedConfigStore,
}

impl GatedConfig {
    pub fn external_host_from_config(&self) -> Option<(Scheme, String, Option<u16>)> {
        if let Some(external_host) = self.store.external_host.as_ref() {
            #[allow(
                clippy::unwrap_used,
                reason = "str::split always yields at least one element"
            )]
            let external_host = external_host.split(":").next().unwrap();

            let scheme = if self.store.http.tls {
                Scheme::HTTPS
            } else {
                Scheme::HTTP
            };

            Some((
                scheme,
                external_host.to_owned(),
                self.store
                    .http
                    .external_port
                    .or(Some(self.store.http.listen.port())),
            ))
        } else {
            None
        }
    }

    /// Extract external host:port from request headers
    pub fn external_host_from_request(
        &self,
        request: &poem::Request,
    ) -> Option<(Scheme, String, Option<u16>)> {
        let default_scheme = if self.store.http.tls {
            Scheme::HTTPS
        } else {
            Scheme::HTTP
        };
        let (mut scheme, mut host, mut port) = (default_scheme, None, None);
        let trust_forwarded_headers = self.store.http.trust_x_forwarded_headers;

        // Try the Host header first
        scheme = request.uri().scheme().cloned().unwrap_or(scheme);

        let original_url = request.original_uri();
        if let Some(original_host) = original_url.host() {
            host = Some(original_host.to_string());
            port = original_url.port().map(|x| x.as_u16());
        }

        // But prefer X-Forwarded-* headers if enabled
        if trust_forwarded_headers {
            scheme = request
                .header("x-forwarded-proto")
                .and_then(|x| Scheme::try_from(x).ok())
                .unwrap_or(scheme);

            if let Some(xfh) = request.header("x-forwarded-host") {
                // XFH can contain both host and port
                let parts = xfh.split(':').collect::<Vec<_>>();
                host = parts.first().map(|x| x.to_string()).or(host);
                port = parts.get(1).and_then(|x| x.parse::<u16>().ok());
            }

            port = request
                .header("x-forwarded-port")
                .and_then(|x| x.parse::<u16>().ok())
                .or(port);
        }

        host.map(|host| (scheme, host, port))
    }

    pub fn construct_external_url(
        &self,
        for_request: Option<&poem::Request>,
        domain_whitelist: Option<&[String]>,
    ) -> Result<Url, GatedError> {
        let Some((scheme, host, port)) = for_request
            .and_then(|r| self.external_host_from_request(r))
            .or(self.external_host_from_config())
        else {
            return Err(GatedError::ExternalHostUnknown);
        };

        if let Some(list) = domain_whitelist
            && !list.contains(&host)
        {
            return Err(GatedError::ExternalHostNotWhitelisted(
                host.clone(),
                list.iter().map(|x| x.to_string()).collect(),
            ));
        }

        let mut url = format!("{scheme}://{host}");
        if let Some(port) = port {
            // can't `match` `Scheme`
            if scheme == Scheme::HTTP && port != 80 || scheme == Scheme::HTTPS && port != 443 {
                url = format!("{url}:{port}");
            }
        };
        Url::parse(&url).map_err(GatedError::UrlParse)
    }

    pub fn validate(&self) {
        if let Some(ref ext) = self.store.external_host
            && ext.contains(':')
        {
            warn!(
                "Looks like your `external_host` config option contains a port - it will be ignored."
            );
            warn!(
                "Set the external port via the `http.external_port`, `ssh.external_port` or `mysql.external_port` options."
            );
        }
    }
}

#[cfg(test)]
mod host_key_default_tests {
    #[test]
    fn unknown_hosts_are_rejected_by_default() {
        assert_eq!(
            super::SshHostKeyVerificationMode::default(),
            super::SshHostKeyVerificationMode::AutoReject
        );
    }
}
