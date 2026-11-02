//! Facts about an established web terminal connection, sent with the
//! `connected` status frame so the UI can show them on demand.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectedDetails {
    pub session_id: String,
    /// Upstream `host:port`.
    pub address: String,
    /// Upstream account.
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<HostKeyDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tls: Option<TlsDetails>,
    /// Database CLI running in the terminal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostKeyDetails {
    pub algorithm: String,
    /// OpenSSH `SHA256:` fingerprint.
    pub fingerprint: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct TlsDetails {
    /// `disabled|preferred|required`.
    pub mode: String,
    pub verify: bool,
}

impl TlsDetails {
    pub fn from_tls(tls: &gated_common::Tls) -> Self {
        Self {
            mode: match tls.mode {
                gated_tls::TlsMode::Disabled => "disabled",
                gated_tls::TlsMode::Preferred => "preferred",
                gated_tls::TlsMode::Required => "required",
            }
            .into(),
            verify: tls.verify,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omits_facts_the_protocol_does_not_have() {
        let details = ConnectedDetails {
            session_id: "s".into(),
            address: "db:5432".into(),
            username: "app".into(),
            host_key: None,
            tls: Some(TlsDetails::from_tls(&gated_common::Tls {
                mode: gated_tls::TlsMode::Required,
                verify: false,
            })),
            client: Some("psql".into()),
            database: None,
        };
        assert_eq!(
            serde_json::to_value(&details).expect("serialize"),
            serde_json::json!({
                "session_id": "s",
                "address": "db:5432",
                "username": "app",
                "tls": { "mode": "required", "verify": false },
                "client": "psql",
            })
        );
    }
}
