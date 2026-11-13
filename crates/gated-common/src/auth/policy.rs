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

/// A registered public key satisfies the policy on its own; otherwise the
/// inner policy applies. Used for SSH, where OTP enrollment turns the policy
/// into `[Password, Totp]`: the key is a factor the user holds, like OpenSSH
/// `AuthenticationMethods publickey password,keyboard-interactive`. When
/// the inner policy itself names `PublicKey`, the administrator asked for
/// the key plus another factor and the shortcut does not apply.
pub struct PublicKeyOrPolicy {
    pub inner: AllCredentialsPolicy,
    pub supported_credential_types: HashSet<CredentialKind>,
}

impl CredentialPolicy for PublicKeyOrPolicy {
    fn is_sufficient(
        &self,
        protocol: &str,
        valid_credentials: &[AuthCredential],
    ) -> CredentialPolicyResponse {
        let key_is_enough = !self
            .inner
            .required_credential_types
            .contains(&CredentialKind::PublicKey);
        if key_is_enough
            && valid_credentials
                .iter()
                .any(|c| c.kind() == CredentialKind::PublicKey)
        {
            return CredentialPolicyResponse::Ok;
        }
        match self.inner.is_sufficient(protocol, valid_credentials) {
            CredentialPolicyResponse::Need(mut kinds)
                if key_is_enough
                    && self
                        .supported_credential_types
                        .contains(&CredentialKind::PublicKey) =>
            {
                kinds.insert(CredentialKind::PublicKey);
                CredentialPolicyResponse::Need(kinds)
            }
            other => other,
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

/// Demands `factor` on one protocol on top of whatever `inner` asks for.
/// Used to enforce MFA: no stored credential policy can leave the factor out.
pub struct RequiredFactorPolicy {
    pub inner: Box<dyn CredentialPolicy + Send + Sync>,
    pub protocol: &'static str,
    pub factor: CredentialKind,
}

impl CredentialPolicy for RequiredFactorPolicy {
    fn is_sufficient(
        &self,
        protocol: &str,
        valid_credentials: &[AuthCredential],
    ) -> CredentialPolicyResponse {
        let response = self.inner.is_sufficient(protocol, valid_credentials);
        if protocol != self.protocol || valid_credentials.iter().any(|c| c.kind() == self.factor) {
            return response;
        }
        let mut needed = match response {
            CredentialPolicyResponse::Ok => HashSet::new(),
            CredentialPolicyResponse::Need(needed) => needed,
        };
        needed.insert(self.factor);
        CredentialPolicyResponse::Need(needed)
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

    fn public_key() -> AuthCredential {
        AuthCredential::PublicKey {
            kind: russh::keys::Algorithm::Ed25519,
            public_key_bytes: bytes::Bytes::from_static(b"key"),
        }
    }

    fn mfa(required: &[CredentialKind]) -> PublicKeyOrPolicy {
        PublicKeyOrPolicy {
            inner: AllCredentialsPolicy {
                required_credential_types: required.iter().copied().collect(),
                supported_credential_types: HashSet::from([
                    CredentialKind::Password,
                    CredentialKind::Totp,
                    CredentialKind::PublicKey,
                ]),
            },
            supported_credential_types: HashSet::from([
                CredentialKind::Password,
                CredentialKind::Totp,
                CredentialKind::PublicKey,
            ]),
        }
    }

    /// A registered key signs in on its own even when OTP enrollment
    /// made the policy `[Password, Totp]`.
    #[test]
    fn public_key_alone_satisfies_a_password_otp_policy() {
        let policy = mfa(&[CredentialKind::Password, CredentialKind::Totp]);
        assert!(matches!(
            policy.is_sufficient("SSH", &[public_key()]),
            CredentialPolicyResponse::Ok
        ));
        // Password plus OTP still works for users without a key at hand.
        assert!(matches!(
            policy.is_sufficient("SSH", &[password(), otp()]),
            CredentialPolicyResponse::Ok
        ));
        assert!(matches!(
            policy.is_sufficient("SSH", &[password()]),
            CredentialPolicyResponse::Need(_)
        ));
    }

    /// Before any credential the client must be offered the key as well
    /// as the inner policy's factors.
    #[test]
    fn public_key_is_offered_as_an_alternative() {
        let policy = mfa(&[CredentialKind::Password, CredentialKind::Totp]);
        let CredentialPolicyResponse::Need(kinds) = policy.is_sufficient("SSH", &[]) else {
            panic!("nothing presented must not be sufficient");
        };
        assert_eq!(
            kinds,
            HashSet::from([
                CredentialKind::PublicKey,
                CredentialKind::Password,
                CredentialKind::Totp,
            ])
        );
    }

    /// A key is not offered to a user who has none registered.
    #[test]
    fn public_key_is_not_offered_without_a_registered_key() {
        let mut policy = mfa(&[CredentialKind::Password, CredentialKind::Totp]);
        policy
            .supported_credential_types
            .remove(&CredentialKind::PublicKey);
        let CredentialPolicyResponse::Need(kinds) = policy.is_sufficient("SSH", &[]) else {
            panic!("nothing presented must not be sufficient");
        };
        assert_eq!(
            kinds,
            HashSet::from([CredentialKind::Password, CredentialKind::Totp])
        );
    }

    /// When the administrator names the key in the policy, they asked
    /// for key plus another factor: the key alone is not enough.
    #[test]
    fn public_key_alone_is_not_enough_when_the_policy_requires_it() {
        let policy = mfa(&[CredentialKind::PublicKey, CredentialKind::Totp]);
        assert!(matches!(
            policy.is_sufficient("SSH", &[public_key()]),
            CredentialPolicyResponse::Need(_)
        ));
        assert!(matches!(
            policy.is_sufficient("SSH", &[public_key(), otp()]),
            CredentialPolicyResponse::Ok
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

    fn otp_on_http(inner: Box<dyn CredentialPolicy + Send + Sync>) -> RequiredFactorPolicy {
        RequiredFactorPolicy {
            inner,
            protocol: "HTTP",
            factor: CredentialKind::Totp,
        }
    }

    fn any_password() -> Box<dyn CredentialPolicy + Send + Sync> {
        Box::new(AnySingleCredentialPolicy {
            supported_credential_types: HashSet::from([CredentialKind::Password]),
        })
    }

    #[test]
    fn required_factor_is_demanded_on_top_of_the_inner_policy() {
        let policy = otp_on_http(any_password());

        let CredentialPolicyResponse::Need(needed) = policy.is_sufficient("HTTP", &[]) else {
            panic!("expected Need");
        };
        assert_eq!(
            needed,
            HashSet::from([CredentialKind::Password, CredentialKind::Totp])
        );

        let CredentialPolicyResponse::Need(needed) = policy.is_sufficient("HTTP", &[password()])
        else {
            panic!("expected Need");
        };
        assert_eq!(needed, HashSet::from([CredentialKind::Totp]));

        assert!(matches!(
            policy.is_sufficient("HTTP", &[password(), otp()]),
            CredentialPolicyResponse::Ok
        ));
    }

    #[test]
    fn required_factor_alone_does_not_satisfy_the_inner_policy() {
        let policy = otp_on_http(Box::new(AllCredentialsPolicy {
            required_credential_types: HashSet::from([CredentialKind::Password]),
            supported_credential_types: HashSet::from([CredentialKind::Password]),
        }));
        assert!(matches!(
            policy.is_sufficient("HTTP", &[otp()]),
            CredentialPolicyResponse::Need(_)
        ));
    }

    #[test]
    fn required_factor_leaves_other_protocols_alone() {
        let policy = otp_on_http(any_password());
        assert!(matches!(
            policy.is_sufficient("SSH", &[password()]),
            CredentialPolicyResponse::Ok
        ));
    }
}
