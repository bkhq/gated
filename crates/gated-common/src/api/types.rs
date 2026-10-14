//! Wire representations of configuration types whose API format differs from
//! the serde format persisted in the database.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::CredentialKind as StoredCredentialKind;
use crate::config as stored;
use crate::{
    BearerTokenUpstreamAuth, ClientCertificateUpstreamAuth, HeadersUpstreamAuth, HttpProxyFlavor,
    Secret, SshTargetPasswordAuth, SshTargetPublicKeyAuth, TargetAccountMetadata,
};

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, ToSchema)]
pub enum TlsMode {
    Disabled,
    Preferred,
    Required,
}

impl From<gated_tls::TlsMode> for TlsMode {
    fn from(mode: gated_tls::TlsMode) -> Self {
        match mode {
            gated_tls::TlsMode::Disabled => Self::Disabled,
            gated_tls::TlsMode::Preferred => Self::Preferred,
            gated_tls::TlsMode::Required => Self::Required,
        }
    }
}

impl From<TlsMode> for gated_tls::TlsMode {
    fn from(mode: TlsMode) -> Self {
        match mode {
            TlsMode::Disabled => Self::Disabled,
            TlsMode::Preferred => Self::Preferred,
            TlsMode::Required => Self::Required,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
pub struct Tls {
    pub mode: TlsMode,
    pub verify: bool,
}

impl From<stored::Tls> for Tls {
    fn from(tls: stored::Tls) -> Self {
        Self {
            mode: tls.mode.into(),
            verify: tls.verify,
        }
    }
}

impl From<Tls> for stored::Tls {
    fn from(tls: Tls) -> Self {
        Self {
            mode: tls.mode.into(),
            verify: tls.verify,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, ToSchema)]
#[serde(tag = "kind")]
pub enum SSHTargetAuth {
    Password(SshTargetPasswordAuth),
    PublicKey(SshTargetPublicKeyAuth),
}

impl From<stored::SSHTargetAuth> for SSHTargetAuth {
    fn from(auth: stored::SSHTargetAuth) -> Self {
        match auth {
            stored::SSHTargetAuth::Password(auth) => Self::Password(auth),
            stored::SSHTargetAuth::PublicKey(auth) => Self::PublicKey(auth),
        }
    }
}

impl From<SSHTargetAuth> for stored::SSHTargetAuth {
    fn from(auth: SSHTargetAuth) -> Self {
        match auth {
            SSHTargetAuth::Password(auth) => Self::Password(auth),
            SSHTargetAuth::PublicKey(auth) => Self::PublicKey(auth),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
pub struct TargetSSHOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub allow_insecure_algos: Option<bool>,
    pub auth: SSHTargetAuth,
}

impl From<stored::TargetSSHOptions> for TargetSSHOptions {
    fn from(options: stored::TargetSSHOptions) -> Self {
        Self {
            host: options.host,
            port: options.port,
            username: options.username,
            allow_insecure_algos: options.allow_insecure_algos,
            auth: options.auth.into(),
        }
    }
}

impl From<TargetSSHOptions> for stored::TargetSSHOptions {
    fn from(options: TargetSSHOptions) -> Self {
        Self {
            host: options.host,
            port: options.port,
            username: options.username,
            allow_insecure_algos: options.allow_insecure_algos,
            auth: options.auth.into(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
pub struct TargetMySqlOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub tls: Tls,
    pub default_database_name: Option<String>,
    /// When true, the SQL Console rejects anything not starting with
    /// SELECT / SHOW / EXPLAIN / WITH. This is convenience-level only —
    /// use a real read-only DB user for hard guarantees.
    pub readonly: bool,
}

impl From<stored::TargetMySqlOptions> for TargetMySqlOptions {
    fn from(options: stored::TargetMySqlOptions) -> Self {
        Self {
            host: options.host,
            port: options.port,
            username: options.username,
            password: options.password,
            tls: options.tls.into(),
            default_database_name: options.default_database_name,
            readonly: options.readonly,
        }
    }
}

impl From<TargetMySqlOptions> for stored::TargetMySqlOptions {
    fn from(options: TargetMySqlOptions) -> Self {
        Self {
            host: options.host,
            port: options.port,
            username: options.username,
            password: options.password,
            tls: options.tls.into(),
            default_database_name: options.default_database_name,
            readonly: options.readonly,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
pub struct TargetPostgresOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub tls: Tls,
    pub idle_timeout: Option<String>,
    pub default_database_name: Option<String>,
    /// See `TargetMySqlOptions::readonly`.
    pub readonly: bool,
}

impl From<stored::TargetPostgresOptions> for TargetPostgresOptions {
    fn from(options: stored::TargetPostgresOptions) -> Self {
        Self {
            host: options.host,
            port: options.port,
            username: options.username,
            password: options.password,
            tls: options.tls.into(),
            idle_timeout: options.idle_timeout,
            default_database_name: options.default_database_name,
            readonly: options.readonly,
        }
    }
}

impl From<TargetPostgresOptions> for stored::TargetPostgresOptions {
    fn from(options: TargetPostgresOptions) -> Self {
        Self {
            host: options.host,
            port: options.port,
            username: options.username,
            password: options.password,
            tls: options.tls.into(),
            idle_timeout: options.idle_timeout,
            default_database_name: options.default_database_name,
            readonly: options.readonly,
        }
    }
}

/// Empty marker for the `None` variant of [`UpstreamAuth`].
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, Default, ToSchema)]
pub struct NoUpstreamAuth {}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, ToSchema)]
#[serde(tag = "kind")]
pub enum UpstreamAuth {
    None(NoUpstreamAuth),
    Headers(HeadersUpstreamAuth),
    BearerToken(BearerTokenUpstreamAuth),
    ClientCertificate(ClientCertificateUpstreamAuth),
}

impl From<stored::UpstreamAuth> for UpstreamAuth {
    fn from(auth: stored::UpstreamAuth) -> Self {
        match auth {
            stored::UpstreamAuth::None(_) => Self::None(NoUpstreamAuth {}),
            stored::UpstreamAuth::Headers(auth) => Self::Headers(auth),
            stored::UpstreamAuth::BearerToken(auth) => Self::BearerToken(auth),
            stored::UpstreamAuth::ClientCertificate(auth) => Self::ClientCertificate(auth),
        }
    }
}

impl From<UpstreamAuth> for stored::UpstreamAuth {
    fn from(auth: UpstreamAuth) -> Self {
        match auth {
            UpstreamAuth::None(_) => Self::None(stored::NoUpstreamAuth {}),
            UpstreamAuth::Headers(auth) => Self::Headers(auth),
            UpstreamAuth::BearerToken(auth) => Self::BearerToken(auth),
            UpstreamAuth::ClientCertificate(auth) => Self::ClientCertificate(auth),
        }
    }
}

/// Unified HTTP-reverse-proxy target. `flavor` toggles Kubernetes-specific
/// behaviour (channel.k8s.io WebSocket, watch streaming, exec/attach
/// recording enrichment).
#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
pub struct TargetHttpOptions {
    /// Upstream base URL (e.g. `https://kubernetes.example.com` for K8s,
    /// or any http(s) origin for generic targets).
    pub url: String,
    /// TLS settings for the upstream connection. `tls.verify` defaults to
    /// `true`; set it to `false` only for a target with a self-signed or
    /// otherwise unverifiable cert.
    pub tls: Tls,
    /// Optional PEM bundle of CA certificates trusted for the upstream
    /// connection (e.g. an in-cluster signing CA).
    #[schema(value_type = Option<String>)]
    pub ca_certificate: Option<Secret<String>>,
    /// How Gated authenticates to the upstream service.
    pub upstream_auth: UpstreamAuth,
    /// Protocol-level behaviours unlocked for this target.
    pub flavor: HttpProxyFlavor,
}

impl From<stored::TargetHttpOptions> for TargetHttpOptions {
    fn from(options: stored::TargetHttpOptions) -> Self {
        Self {
            url: options.url,
            tls: options.tls.into(),
            ca_certificate: options.ca_certificate,
            upstream_auth: options.upstream_auth.into(),
            flavor: options.flavor,
        }
    }
}

impl From<TargetHttpOptions> for stored::TargetHttpOptions {
    fn from(options: TargetHttpOptions) -> Self {
        Self {
            url: options.url,
            tls: options.tls.into(),
            ca_certificate: options.ca_certificate,
            upstream_auth: options.upstream_auth.into(),
            flavor: options.flavor,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
#[serde(tag = "kind")]
pub enum TargetOptions {
    Ssh(TargetSSHOptions),
    Http(TargetHttpOptions),
    MySql(TargetMySqlOptions),
    Postgres(TargetPostgresOptions),
}

impl From<stored::TargetOptions> for TargetOptions {
    fn from(options: stored::TargetOptions) -> Self {
        match options {
            stored::TargetOptions::Ssh(options) => Self::Ssh(options.into()),
            stored::TargetOptions::Http(options) => Self::Http(options.into()),
            stored::TargetOptions::MySql(options) => Self::MySql(options.into()),
            stored::TargetOptions::Postgres(options) => Self::Postgres(options.into()),
        }
    }
}

impl From<TargetOptions> for stored::TargetOptions {
    fn from(options: TargetOptions) -> Self {
        match options {
            TargetOptions::Ssh(options) => Self::Ssh(options.into()),
            TargetOptions::Http(options) => Self::Http(options.into()),
            TargetOptions::MySql(options) => Self::MySql(options.into()),
            TargetOptions::Postgres(options) => Self::Postgres(options.into()),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
pub struct Target {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub allow_roles: Vec<String>,
    pub options: TargetOptions,
    pub accounts: Vec<TargetAccountMetadata>,
    pub rate_limit_bytes_per_second: Option<u32>,
    pub group_id: Option<Uuid>,
}

impl From<stored::Target> for Target {
    fn from(target: stored::Target) -> Self {
        Self {
            id: target.id,
            name: target.name,
            description: target.description,
            allow_roles: target.allow_roles,
            options: target.options.into(),
            accounts: target.accounts,
            rate_limit_bytes_per_second: target.rate_limit_bytes_per_second,
            group_id: target.group_id,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Hash, ToSchema)]
pub enum CredentialKind {
    Password,
    PublicKey,
    Certificate,
    Totp,
    Sso,
    WebUserApproval,
}

impl From<StoredCredentialKind> for CredentialKind {
    fn from(kind: StoredCredentialKind) -> Self {
        match kind {
            StoredCredentialKind::Password => Self::Password,
            StoredCredentialKind::PublicKey => Self::PublicKey,
            StoredCredentialKind::Certificate => Self::Certificate,
            StoredCredentialKind::Totp => Self::Totp,
            StoredCredentialKind::Sso => Self::Sso,
            StoredCredentialKind::WebUserApproval => Self::WebUserApproval,
        }
    }
}

impl From<CredentialKind> for StoredCredentialKind {
    fn from(kind: CredentialKind) -> Self {
        match kind {
            CredentialKind::Password => Self::Password,
            CredentialKind::PublicKey => Self::PublicKey,
            CredentialKind::Certificate => Self::Certificate,
            CredentialKind::Totp => Self::Totp,
            CredentialKind::Sso => Self::Sso,
            CredentialKind::WebUserApproval => Self::WebUserApproval,
        }
    }
}

fn kinds_from_stored(kinds: Option<Vec<StoredCredentialKind>>) -> Option<Vec<CredentialKind>> {
    kinds.map(|kinds| kinds.into_iter().map(Into::into).collect())
}

fn kinds_into_stored(kinds: Option<Vec<CredentialKind>>) -> Option<Vec<StoredCredentialKind>> {
    kinds.map(|kinds| kinds.into_iter().map(Into::into).collect())
}

#[derive(Debug, Deserialize, Serialize, Clone, Default, ToSchema)]
pub struct UserRequireCredentialsPolicy {
    pub http: Option<Vec<CredentialKind>>,
    pub kubernetes: Option<Vec<CredentialKind>>,
    pub ssh: Option<Vec<CredentialKind>>,
    pub mysql: Option<Vec<CredentialKind>>,
    pub postgres: Option<Vec<CredentialKind>>,
}

impl From<stored::UserRequireCredentialsPolicy> for UserRequireCredentialsPolicy {
    fn from(policy: stored::UserRequireCredentialsPolicy) -> Self {
        Self {
            http: kinds_from_stored(policy.http),
            kubernetes: kinds_from_stored(policy.kubernetes),
            ssh: kinds_from_stored(policy.ssh),
            mysql: kinds_from_stored(policy.mysql),
            postgres: kinds_from_stored(policy.postgres),
        }
    }
}

impl From<UserRequireCredentialsPolicy> for stored::UserRequireCredentialsPolicy {
    fn from(policy: UserRequireCredentialsPolicy) -> Self {
        Self {
            http: kinds_into_stored(policy.http),
            kubernetes: kinds_into_stored(policy.kubernetes),
            ssh: kinds_into_stored(policy.ssh),
            mysql: kinds_into_stored(policy.mysql),
            postgres: kinds_into_stored(policy.postgres),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, ToSchema)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub description: String,
    pub credential_policy: Option<UserRequireCredentialsPolicy>,
    pub rate_limit_bytes_per_second: Option<i64>,
}

impl From<stored::User> for User {
    fn from(user: stored::User) -> Self {
        Self {
            id: user.id,
            username: user.username,
            description: user.description,
            credential_policy: user.credential_policy.map(Into::into),
            rate_limit_bytes_per_second: user.rate_limit_bytes_per_second,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn ssh_target() -> stored::Target {
        stored::Target {
            id: Uuid::nil(),
            name: "bastion".into(),
            description: String::new(),
            allow_roles: vec!["ops".into()],
            options: stored::TargetOptions::Ssh(stored::TargetSSHOptions {
                host: "10.0.0.1".into(),
                port: 22,
                username: "root".into(),
                allow_insecure_algos: None,
                auth: stored::SSHTargetAuth::Password(SshTargetPasswordAuth {
                    password: Secret::new("pw".into()),
                }),
            }),
            accounts: vec![],
            rate_limit_bytes_per_second: None,
            group_id: None,
        }
    }

    #[test]
    fn target_uses_kind_tagged_options_on_the_wire() {
        assert_eq!(
            serde_json::to_value(Target::from(ssh_target())).unwrap(),
            json!({
                "id": "00000000-0000-0000-0000-000000000000",
                "name": "bastion",
                "description": "",
                "allow_roles": ["ops"],
                "options": {
                    "kind": "Ssh",
                    "host": "10.0.0.1",
                    "port": 22,
                    "username": "root",
                    "allow_insecure_algos": null,
                    "auth": {"kind": "Password", "password": "pw"},
                },
                "accounts": [],
                "rate_limit_bytes_per_second": null,
                "group_id": null,
            })
        );
    }

    // The persisted representation must not follow the wire one.
    #[test]
    fn stored_target_format_is_unchanged() {
        assert_eq!(
            serde_json::to_value(ssh_target()).unwrap(),
            json!({
                "id": "00000000-0000-0000-0000-000000000000",
                "name": "bastion",
                "description": "",
                "allow_roles": ["ops"],
                "ssh": {
                    "host": "10.0.0.1",
                    "port": 22,
                    "username": "root",
                    "allow_insecure_algos": null,
                    "auth": {"password": "pw"},
                },
                "accounts": [],
                "rate_limit_bytes_per_second": null,
                "group_id": null,
            })
        );
    }

    #[test]
    fn http_options_round_trip_through_the_wire_format() {
        let wire = json!({
            "kind": "Http",
            "url": "https://k8s.example.com",
            "tls": {"mode": "Preferred", "verify": false},
            "ca_certificate": null,
            "upstream_auth": {"kind": "BearerToken", "token": "t"},
            "flavor": "kubernetes",
        });
        let options: TargetOptions = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&options).unwrap(), wire);

        let stored::TargetOptions::Http(stored) = options.into() else {
            panic!("expected HTTP options");
        };
        assert_eq!(stored.tls.mode, gated_tls::TlsMode::Preferred);
        assert_eq!(
            stored.upstream_auth,
            stored::UpstreamAuth::BearerToken(BearerTokenUpstreamAuth {
                token: Secret::new("t".into()),
            })
        );
    }

    #[test]
    fn empty_upstream_auth_accepts_only_its_tag() {
        let auth: UpstreamAuth = serde_json::from_value(json!({"kind": "None"})).unwrap();
        assert_eq!(auth, UpstreamAuth::None(NoUpstreamAuth {}));
    }

    #[test]
    fn credential_policy_uses_variant_names_and_explicit_nulls() {
        let policy = UserRequireCredentialsPolicy::from(stored::UserRequireCredentialsPolicy {
            http: Some(vec![
                StoredCredentialKind::Password,
                StoredCredentialKind::Totp,
            ]),
            ..Default::default()
        });
        assert_eq!(
            serde_json::to_value(policy).unwrap(),
            json!({
                "http": ["Password", "Totp"],
                "kubernetes": null,
                "ssh": null,
                "mysql": null,
                "postgres": null,
            })
        );
    }
}
