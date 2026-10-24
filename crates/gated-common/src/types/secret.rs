use std::fmt::Debug;

use bytes::Bytes;
use data_encoding::HEXLOWER;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::helpers::rng::get_crypto_rng;

#[derive(PartialEq, Eq, Clone)]
pub struct Secret<T>(T);

/// Deterministic digest used to store and look up high-entropy
/// comparison secrets (e.g. API tokens) so the plaintext is never persisted.
///
/// The presented secret is hashed and matched against the stored digest. The
/// digest is preimage-resistant, so equality on the digest (e.g. a SQL
/// `WHERE`) never discloses the underlying secret. SHA-256 (rather than a slow
/// password hash) is appropriate here because the inputs are full-entropy
/// random tokens, not human-chosen passwords.
pub fn hash_secret(secret: &str) -> String {
    HEXLOWER.encode(&Sha256::digest(secret.as_bytes()))
}

impl Secret<String> {
    pub fn random() -> Self {
        Secret::new(HEXLOWER.encode(&Bytes::from_iter(get_crypto_rng().r#gen::<[u8; 32]>())))
    }

    /// Constant-time comparison against a plaintext candidate.
    ///
    /// Whether the two values match must not be derivable from how long the
    /// comparison takes, so we never fall back on the byte-by-byte short
    /// circuit of derived `PartialEq`. Only the length (which is not the
    /// secret) is allowed to influence timing.
    pub fn ct_eq(&self, candidate: &str) -> bool {
        self.0.as_bytes().ct_eq(candidate.as_bytes()).into()
    }
}

impl<T> Secret<T> {
    pub const fn new(v: T) -> Self {
        Self(v)
    }

    pub fn expose_secret(&self) -> &T {
        &self.0
    }
}

impl<T> From<T> for Secret<T> {
    fn from(v: T) -> Self {
        Self::new(v)
    }
}

impl<'de, T> Deserialize<'de> for Secret<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let v = Deserialize::deserialize::<D>(deserializer)?;
        Ok(Self::new(v))
    }
}

impl<T> Serialize for Secret<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<T> Debug for Secret<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<secret>")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Debug must never reveal the wrapped secret.
    #[test]
    fn debug_is_redacted() {
        let secret = Secret::new("super-secret-token".to_owned());
        assert_eq!(format!("{secret:?}"), "<secret>");
    }

    // Constant-time comparison still returns the correct result.
    #[test]
    fn ct_eq_matches_only_identical_values() {
        let secret = Secret::new("correct-token".to_owned());
        assert!(secret.ct_eq("correct-token"));
        assert!(!secret.ct_eq("correct-toke")); // shorter
        assert!(!secret.ct_eq("correct-tokez")); // same length, differs
        assert!(!secret.ct_eq("wrong"));
    }

    // Hashing is deterministic and never echoes the plaintext.
    #[test]
    fn hash_secret_is_deterministic_and_hides_plaintext() {
        let token = "0123456789abcdef";
        let digest = hash_secret(token);
        assert_eq!(digest, hash_secret(token));
        assert_ne!(digest, token);
        assert_eq!(digest.len(), 64); // SHA-256 as lowercase hex
        assert!(!digest.contains(token));
    }
}
