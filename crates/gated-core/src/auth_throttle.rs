//! Failed password and OTP attempts, counted across every listener.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant};

use gated_common::GatedError;
use gated_common::auth::AuthCredential;
use gated_common::helpers::hash::verify_password_hash;
use tokio::sync::Mutex;
use tracing::warn;

use crate::{ConfigProvider, ConfigProviderEnum};

const WINDOW: Duration = Duration::from_secs(5 * 60);
/// Failures allowed per window before further attempts are refused.
const MAX_PAIR_FAILURES: u32 = 10;
const MAX_ADDRESS_FAILURES: u32 = 60;
const MAX_USER_FAILURES: u32 = 100;
const MAX_OTP_FAILURES: u32 = 10;
const MAX_KEYS: usize = 50_000;
const MAX_NAME_LEN: usize = 256;

#[derive(Default)]
struct Throttle {
    /// Failure count and start of the window it belongs to.
    failures: HashMap<String, (u32, Instant)>,
}

impl Throttle {
    fn count(&self, key: &str, now: Instant) -> u32 {
        match self.failures.get(key) {
            Some((count, started)) if now.duration_since(*started) < WINDOW => *count,
            _ => 0,
        }
    }

    /// A full table refuses keys it cannot count.
    fn blocked(&self, keys: &[(String, u32)], now: Instant) -> bool {
        keys.iter().any(|(key, limit)| {
            self.count(key, now) >= *limit
                || (self.failures.len() >= MAX_KEYS && !self.failures.contains_key(key))
        })
    }

    fn record(&mut self, keys: &[(String, u32)], now: Instant) {
        if self.failures.len() >= MAX_KEYS {
            self.failures
                .retain(|_, (_, started)| now.duration_since(*started) < WINDOW);
        }
        for (key, _) in keys {
            let count = self.count(key, now);
            if count == 0 {
                if self.failures.len() >= MAX_KEYS && !self.failures.contains_key(key) {
                    continue;
                }
                self.failures.insert(key.clone(), (1, now));
            } else if let Some(entry) = self.failures.get_mut(key) {
                entry.0 = count + 1;
            }
        }
    }
}

static THROTTLE: LazyLock<StdMutex<Throttle>> = LazyLock::new(StdMutex::default);

/// Counters a failed attempt with this credential is charged to. Only
/// guessable secrets are counted.
fn keys(username: &str, client: &str, credential: &AuthCredential) -> Vec<(String, u32)> {
    let username: String = username.chars().take(MAX_NAME_LEN).collect();
    let address = (format!("addr:{client}"), MAX_ADDRESS_FAILURES);
    match credential {
        AuthCredential::Password(_) => vec![
            (format!("pair:{username}|{client}"), MAX_PAIR_FAILURES),
            (format!("user:{username}"), MAX_USER_FAILURES),
            address,
        ],
        AuthCredential::Otp(_) => vec![(format!("otp:{username}"), MAX_OTP_FAILURES), address],
        _ => Vec::new(),
    }
}

/// Validates a credential without holding the provider lock, or an async
/// worker, while a password hash is verified.
pub async fn validate_credential(
    provider: &Mutex<ConfigProviderEnum>,
    username: &str,
    credential: &AuthCredential,
) -> Result<bool, GatedError> {
    let AuthCredential::Password(password) = credential else {
        return provider
            .lock()
            .await
            .validate_credential(username, credential)
            .await;
    };
    let hashes = provider.lock().await.password_hashes(username).await?;
    let password = password.clone();
    tokio::task::spawn_blocking(move || {
        hashes.iter().any(|hash| {
            verify_password_hash(password.expose_secret(), hash.expose_secret()).unwrap_or(false)
        })
    })
    .await
    .map_err(GatedError::other)
}

/// Like [`validate_credential`], unless the user or the client address has
/// failed too often; a refused attempt is reported as a wrong credential.
pub async fn validate_credential_throttled(
    provider: &Mutex<ConfigProviderEnum>,
    username: &str,
    client: &str,
    credential: &AuthCredential,
) -> Result<bool, GatedError> {
    let keys = keys(username, client, credential);
    if THROTTLE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .blocked(&keys, Instant::now())
    {
        warn!(target: "audit", username = %username.chars().take(MAX_NAME_LEN).collect::<String>(), client_ip = %client, "auth_throttled");
        return Ok(false);
    }
    let valid = validate_credential(provider, username, credential).await?;
    if !valid {
        THROTTLE
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .record(&keys, Instant::now());
    }
    Ok(valid)
}

#[cfg(test)]
mod tests {
    use gated_common::Secret;

    use super::*;

    fn password() -> AuthCredential {
        AuthCredential::Password(Secret::new("x".to_owned()))
    }

    #[test]
    fn a_client_is_refused_after_repeated_failures_until_the_window_passes() {
        let mut throttle = Throttle::default();
        let now = Instant::now();
        let keys = keys("alice", "10.0.0.1", &password());
        for _ in 0..MAX_PAIR_FAILURES {
            assert!(!throttle.blocked(&keys, now));
            throttle.record(&keys, now);
        }
        assert!(throttle.blocked(&keys, now));
        assert!(!throttle.blocked(&super::keys("alice", "10.0.0.2", &password()), now));
        assert!(!throttle.blocked(&super::keys("bob", "10.0.0.1", &password()), now));
        assert!(!throttle.blocked(&keys, now + WINDOW));
    }

    #[test]
    fn otp_failures_count_against_the_user_from_any_address() {
        let mut throttle = Throttle::default();
        let now = Instant::now();
        let otp = AuthCredential::Otp(Secret::new("000000".to_owned()));
        for i in 0..MAX_OTP_FAILURES {
            throttle.record(&keys("alice", &format!("10.0.0.{i}"), &otp), now);
        }
        assert!(throttle.blocked(&keys("alice", "10.9.9.9", &otp), now));
        assert!(!throttle.blocked(&keys("alice", "10.9.9.9", &password()), now));
    }

    #[test]
    fn public_keys_are_not_counted_and_the_table_is_bounded() {
        let key = AuthCredential::Certificate {
            certificate_pem: Secret::new(String::new()),
        };
        assert!(keys("alice", "10.0.0.1", &key).is_empty());

        let mut throttle = Throttle::default();
        let now = Instant::now();
        for i in 0..MAX_KEYS + 10 {
            throttle.record(&[(format!("user:{i}"), MAX_USER_FAILURES)], now);
        }
        assert_eq!(throttle.failures.len(), MAX_KEYS);
        assert!(throttle.blocked(&[("user:new".to_owned(), MAX_USER_FAILURES)], now));
        throttle.record(&[("user:new".to_owned(), MAX_USER_FAILURES)], now + WINDOW);
        assert_eq!(throttle.failures.len(), 1);
    }
}
