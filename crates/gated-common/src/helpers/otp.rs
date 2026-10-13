use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use rand::Rng;
use totp_rs::{Algorithm, TOTP};

use super::rng::get_crypto_rng;
use crate::types::Secret;

pub type OtpExposedSecretKey = Vec<u8>;
pub type OtpSecretKey = Secret<OtpExposedSecretKey>;

const STEP: u64 = 30;
const SKEW: u8 = 1;

/// How long a consumed (credential, time-step) entry is retained before
/// pruning. A code is accepted across the whole skew window
/// (`STEP * (2 * SKEW + 1)` ≈ 90s); we keep entries a little longer so a
/// replay anywhere in that window is still recognised.
const CONSUMED_TTL_SECS: u64 = STEP * (2 * SKEW as u64 + 1) + STEP;

/// Tracks recently-accepted TOTP codes to make each code
/// single-use within its validity window. Keyed by
/// `(secret fingerprint, time-step counter)`; values are the unix second
/// the code was consumed, used only for pruning. The fingerprint is a
/// non-reversible hash of the secret, so the raw key is never stored here.
static CONSUMED_TOTP: LazyLock<Mutex<HashMap<(u64, u64), u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn generate_key() -> OtpSecretKey {
    Secret::new(get_crypto_rng().gen::<[u8; 32]>().into())
}

pub fn generate_setup_url(key: &OtpSecretKey, label: &str) -> Secret<String> {
    let totp = get_totp(key, Some(label));
    Secret::new(totp.get_url())
}

fn get_totp(key: &OtpSecretKey, label: Option<&str>) -> TOTP {
    TOTP {
        algorithm: Algorithm::SHA1,
        digits: 6,
        skew: SKEW,
        step: STEP,
        secret: key.expose_secret().clone(),
        issuer: Some("Gated".to_string()),
        account_name: label.unwrap_or("").to_string(),
    }
}

fn unix_now_secs() -> u64 {
    #[allow(
        clippy::unwrap_used,
        reason = "SystemTime::now is always >= UNIX_EPOCH on a sane clock"
    )]
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Non-reversible identifier for a secret, used only as a map key for
/// replay tracking.
fn secret_fingerprint(key: &OtpSecretKey) -> u64 {
    let mut hasher = DefaultHasher::new();
    key.expose_secret().hash(&mut hasher);
    hasher.finish()
}

/// Identify which time-step counter an accepted `code` matched, mirroring
/// the skew window that [`TOTP::check`] scans. Returns `None` if no step
/// matches (which only happens if the code was not actually valid).
fn matched_counter(totp: &TOTP, code: &str, now: u64) -> Option<u64> {
    let basestep = (now / STEP).saturating_sub(SKEW as u64);
    for i in 0..(SKEW as u64 * 2 + 1) {
        let counter = basestep + i;
        if totp.generate(counter * STEP) == code {
            return Some(counter);
        }
    }
    None
}

fn prune_consumed(map: &mut HashMap<(u64, u64), u64>, now: u64) {
    map.retain(|_, ts| now.saturating_sub(*ts) < CONSUMED_TTL_SECS);
}

pub fn verify_totp(code: &str, key: &OtpSecretKey) -> bool {
    let now = unix_now_secs();
    let totp = get_totp(key, None);

    if !totp.check(code, now) {
        return false;
    }

    // The code is valid, but `check` accepts it anywhere in the
    // ~90s skew window, so a captured code is replayable. Bind it to its
    // (credential, time-step) and reject any reuse within that window.
    let Some(counter) = matched_counter(&totp, code, now) else {
        // `check` passed but no step matched — fail closed.
        return false;
    };

    let key_id = secret_fingerprint(key);
    #[allow(clippy::unwrap_used, reason = "panic on poison")]
    let mut consumed = CONSUMED_TOTP.lock().unwrap();
    prune_consumed(&mut consumed, now);
    if consumed.insert((key_id, counter), now).is_some() {
        // This code was already consumed for this credential — replay.
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_code_is_accepted_once_then_replay_is_rejected() {
        let key = generate_key();
        let now = unix_now_secs();
        let code = get_totp(&key, None).generate(now);

        // First use of a fresh, valid code succeeds.
        assert!(verify_totp(&code, &key));
        // The same code must not be accepted again within the
        // validity window.
        assert!(!verify_totp(&code, &key));
    }

    #[test]
    fn out_of_window_code_is_rejected() {
        let key = generate_key();
        let now = unix_now_secs();
        // A code for a step far outside the skew window must not verify.
        let future_code = get_totp(&key, None).generate(now + 100 * STEP);
        assert!(!verify_totp(&future_code, &key));
    }

    #[test]
    fn distinct_secrets_do_not_share_replay_state() {
        let key_a = generate_key();
        let key_b = generate_key();
        let now = unix_now_secs();

        let code_a = get_totp(&key_a, None).generate(now);
        let code_b = get_totp(&key_b, None).generate(now);

        assert!(verify_totp(&code_a, &key_a));
        // A different credential's code is tracked independently.
        assert!(verify_totp(&code_b, &key_b));
    }
}
