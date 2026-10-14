use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum TlsMode {
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "preferred")]
    Preferred,
    // Fail-safe default: never silently fall back to plaintext.
    #[serde(rename = "required")]
    #[default]
    Required,
}

impl From<&str> for TlsMode {
    fn from(s: &str) -> Self {
        match s {
            "Disabled" => TlsMode::Disabled,
            "Preferred" => TlsMode::Preferred,
            "Required" => TlsMode::Required,
            _ => TlsMode::Preferred,
        }
    }
}

impl From<TlsMode> for String {
    fn from(mode: TlsMode) -> Self {
        match mode {
            TlsMode::Disabled => "Disabled".to_string(),
            TlsMode::Preferred => "Preferred".to_string(),
            TlsMode::Required => "Required".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_required() {
        // Fail-safe: never silently fall back to plaintext.
        assert_eq!(TlsMode::default(), TlsMode::Required);
    }
}
