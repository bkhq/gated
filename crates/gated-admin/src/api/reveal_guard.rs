use gated_common::{auth::AuthCredential, Secret};
use poem_openapi::Object;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Object)]
pub struct RevealConfirmation {
    /// Optional free-text note recorded in the audit log.
    pub reason: Option<String>,
    pub password: Option<String>,
    pub otp: Option<String>,
}

impl RevealConfirmation {
    pub fn credential(&self) -> Option<AuthCredential> {
        if self.reason.as_ref().is_some_and(|reason| reason.len() > 500) {
            return None;
        }
        match (&self.password, &self.otp) {
            (Some(password), None) if !password.is_empty() && password.len() <= 1024 => {
                Some(AuthCredential::Password(Secret::new(password.clone())))
            }
            (None, Some(otp)) if otp.len() == 6 && otp.bytes().all(|c| c.is_ascii_digit()) => {
                Some(AuthCredential::Otp(Secret::new(otp.clone())))
            }
            _ => None,
        }
    }
}

const WINDOW: Duration = Duration::from_secs(60);
const OTP_REUSE_WINDOW: Duration = Duration::from_secs(120);
const PER_USER_LIMIT: usize = 10;
const PER_ACCOUNT_LIMIT: usize = 5;

/// Per-actor reveal throttling and OTP single-use tracking. An attempt is
/// counted against the actor first; per-account entries are only created for
/// attempts within the actor limit, so the map stays bounded by
/// `PER_USER_LIMIT + 1` entries per active actor.
#[derive(Default)]
pub struct RevealGuard {
    attempts: HashMap<(String, Option<i32>), (Instant, usize)>,
    used_otp: HashMap<String, Instant>,
}

impl RevealGuard {
    fn prune(&mut self, now: Instant) {
        self.attempts
            .retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
        self.used_otp
            .retain(|_, start| now.duration_since(*start) < OTP_REUSE_WINDOW);
    }

    fn count(&mut self, key: (String, Option<i32>), now: Instant) -> usize {
        let entry = self.attempts.entry(key).or_insert((now, 0));
        entry.1 = entry.1.saturating_add(1);
        entry.1
    }

    pub fn allow(&mut self, user: &str, account: i32, now: Instant) -> bool {
        self.prune(now);
        if self.count((user.to_owned(), None), now) > PER_USER_LIMIT {
            return false;
        }
        self.count((user.to_owned(), Some(account)), now) <= PER_ACCOUNT_LIMIT
    }

    pub fn otp_available(&mut self, user: &str, now: Instant) -> bool {
        self.prune(now);
        !self.used_otp.contains_key(user)
    }

    /// Atomically mark the actor's OTP confirmation as used. Returns `false`
    /// when another reveal already consumed one inside the reuse window.
    pub fn try_consume_otp(&mut self, user: &str, now: Instant) -> bool {
        self.prune(now);
        if self.used_otp.contains_key(user) {
            return false;
        }
        self.used_otp.insert(user.to_owned(), now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmation_requires_exactly_one_factor_and_bounded_reason() {
        let mut body = RevealConfirmation {
            reason: None,
            password: Some("correct".into()),
            otp: None,
        };
        assert!(body.credential().is_some());
        body.reason = Some("x".repeat(501));
        assert!(body.credential().is_none());
        body.reason = Some("maintenance".into());
        assert!(body.credential().is_some());
        body.otp = Some("123456".into());
        assert!(body.credential().is_none());
        body.password = None;
        assert!(body.credential().is_some());
        body.otp = Some("invalid".into());
        assert!(body.credential().is_none());
    }
    #[test]
    fn limits_attempts_per_account_and_actor_and_rejects_otp_reuse() {
        let mut guard = RevealGuard::default();
        let now = Instant::now();
        for _ in 0..5 {
            assert!(guard.allow("alice", 1, now));
        }
        assert!(!guard.allow("alice", 1, now));
        for _ in 0..4 {
            assert!(guard.allow("alice", 2, now));
        }
        assert!(!guard.allow("alice", 3, now));
        assert!(guard.allow("bob", 1, now));
        assert!(guard.try_consume_otp("alice", now));
        assert!(!guard.otp_available("alice", now));
        assert!(!guard.try_consume_otp("alice", now));
        assert!(guard.otp_available("bob", now));
        let later = now + Duration::from_secs(121);
        assert!(guard.allow("alice", 1, later));
        assert!(guard.otp_available("alice", later));
    }

    #[test]
    fn throttled_actor_cannot_grow_the_table_or_lock_out_others() {
        let mut guard = RevealGuard::default();
        let now = Instant::now();
        for account in 0..10_000 {
            guard.allow("mallory", account, now);
        }
        assert!(guard.attempts.len() <= PER_USER_LIMIT + 1);
        assert!(guard.allow("alice", 1, now));
    }
}
