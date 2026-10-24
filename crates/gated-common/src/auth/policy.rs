use std::collections::{HashMap, HashSet};

use super::{AuthCredential, CredentialKind};

pub enum CredentialPolicyResponse {
    Ok,
    Need(HashSet<CredentialKind>),
}

pub trait CredentialPolicy {
    fn is_sufficient(
        &self,
        protocol: &str,
        valid_credentials: &[AuthCredential],
    ) -> CredentialPolicyResponse;
}

pub struct AnySingleCredentialPolicy {
    pub supported_credential_types: HashSet<CredentialKind>,
}

pub struct AllCredentialsPolicy {
    pub required_credential_types: HashSet<CredentialKind>,
    pub supported_credential_types: HashSet<CredentialKind>,
}

pub struct PerProtocolCredentialPolicy {
    pub protocols: HashMap<&'static str, Box<dyn CredentialPolicy + Send + Sync>>,
    pub default: Box<dyn CredentialPolicy + Send + Sync>,
}

impl CredentialPolicy for AnySingleCredentialPolicy {
    fn is_sufficient(
        &self,
        _protocol: &str,
        valid_credentials: &[AuthCredential],
    ) -> CredentialPolicyResponse {
        if valid_credentials.is_empty() {
            CredentialPolicyResponse::Need(
                self.supported_credential_types
                    .clone()
                    .into_iter()
                    .collect(),
            )
        } else {
            CredentialPolicyResponse::Ok
        }
    }
}

impl CredentialPolicy for AllCredentialsPolicy {
    fn is_sufficient(
        &self,
        _protocol: &str,
        valid_credentials: &[AuthCredential],
    ) -> CredentialPolicyResponse {
        // An empty required set must fail closed. `is_superset`
        // of an empty set is vacuously true, so without this guard any
        // single valid credential would satisfy the policy, collapsing
        // MFA. An unconfigured policy must never authorize; an admin has
        // to require at least one credential for it to be satisfiable.
        if self.required_credential_types.is_empty() {
            return CredentialPolicyResponse::Need(HashSet::new());
        }

        let valid_credential_types: HashSet<CredentialKind> =
            valid_credentials.iter().map(|x| x.kind()).collect();

        if !valid_credential_types.is_empty()
            && valid_credential_types.is_superset(&self.required_credential_types)
        {
            CredentialPolicyResponse::Ok
        } else {
            CredentialPolicyResponse::Need(
                self.required_credential_types
                    .difference(&valid_credential_types)
                    .cloned()
                    .collect(),
            )
        }
    }
}

impl CredentialPolicy for PerProtocolCredentialPolicy {
    fn is_sufficient(
        &self,
        protocol: &str,
        valid_credentials: &[AuthCredential],
    ) -> CredentialPolicyResponse {
        if let Some(policy) = self.protocols.get(protocol) {
            policy.is_sufficient(protocol, valid_credentials)
        } else {
            self.default.is_sufficient(protocol, valid_credentials)
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::Secret;

    use super::*;

    fn password() -> AuthCredential {
        AuthCredential::Password(Secret::new("pw".to_owned()))
    }

    fn otp() -> AuthCredential {
        AuthCredential::Otp(Secret::new("123456".to_owned()))
    }

    /// A policy with no required credentials must never
    /// authorize, even when a valid credential is presented.
    #[test]
    fn empty_required_set_fails_closed() {
        let policy = AllCredentialsPolicy {
            required_credential_types: HashSet::new(),
            supported_credential_types: HashSet::from([CredentialKind::Password]),
        };

        // No credentials -> denied.
        assert!(matches!(
            policy.is_sufficient("http", &[]),
            CredentialPolicyResponse::Need(_)
        ));

        // A valid credential still must not satisfy an empty policy.
        assert!(matches!(
            policy.is_sufficient("http", &[password()]),
            CredentialPolicyResponse::Need(_)
        ));
    }

    #[test]
    fn all_required_credentials_satisfy_policy() {
        let policy = AllCredentialsPolicy {
            required_credential_types: HashSet::from([
                CredentialKind::Password,
                CredentialKind::Totp,
            ]),
            supported_credential_types: HashSet::from([
                CredentialKind::Password,
                CredentialKind::Totp,
            ]),
        };

        // Only one of two required factors -> still needs the other.
        assert!(matches!(
            policy.is_sufficient("http", &[password()]),
            CredentialPolicyResponse::Need(_)
        ));

        // Both required factors present -> ok.
        assert!(matches!(
            policy.is_sufficient("http", &[password(), otp()]),
            CredentialPolicyResponse::Ok
        ));
    }
}
