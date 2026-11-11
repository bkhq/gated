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
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostKeyDetails {
    pub algorithm: String,
    /// OpenSSH `SHA256:` fingerprint.
    pub fingerprint: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omits_facts_the_protocol_does_not_have() {
        let details = ConnectedDetails {
            session_id: "s".into(),
            address: "host:22".into(),
            username: "app".into(),
            host_key: None,
        };
        assert_eq!(
            serde_json::to_value(&details).expect("serialize"),
            serde_json::json!({
                "session_id": "s",
                "address": "host:22",
                "username": "app",
            })
        );
    }
}
