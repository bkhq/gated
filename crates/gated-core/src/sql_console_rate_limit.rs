//! Request-rate limiter for the SQL Console and DB Terminal gateway
//! endpoints.
//!
//! Unlike [`crate::rate_limiting::RateLimiterRegistry`] which enforces
//! bytes-per-second on protocol streams, this limiter enforces
//! requests-per-minute per-user and per-target on HTTP endpoints:
//!
//! - `GET  /api/db/schemas/:target`
//! - `GET  /api/db/tables/:target`
//! - `GET  /api/db/columns/:target`
//! - `POST /api/db/query/:target`
//! - `GET  /api/mysql/terminal/:target` (WebSocket)
//! - `GET  /api/postgres/terminal/:target` (WebSocket)
//!
//! Quotas live in the `parameters` table
//! (`sql_console_rate_limit_per_user`, `sql_console_rate_limit_per_target`).
//! Either or both may be NULL, which disables the respective axis.

use std::num::NonZeroU32;
use std::sync::{Arc, RwLock as StdRwLock};

use gated_common::GatedError;
use gated_db_entities::Parameters;
use governor::{DefaultKeyedRateLimiter, Quota};
use thiserror::Error;
use uuid::Uuid;

use crate::SharedDatabaseConnection;

type KeyedLimiter = DefaultKeyedRateLimiter<Uuid>;

/// Retry-After header value returned on a 429 response. A minute matches
/// the quota window used by [`Quota::per_minute`].
pub const DEFAULT_RETRY_AFTER_SECONDS: u64 = 60;

#[derive(Debug, Error)]
pub enum SqlConsoleRateLimitError {
    #[error("per-user request rate limit exceeded")]
    PerUser,
    #[error("per-target request rate limit exceeded")]
    PerTarget,
}

impl SqlConsoleRateLimitError {
    pub fn retry_after_seconds(&self) -> u64 {
        DEFAULT_RETRY_AFTER_SECONDS
    }

    pub fn scope(&self) -> &'static str {
        match self {
            Self::PerUser => "per_user",
            Self::PerTarget => "per_target",
        }
    }
}

pub struct SqlConsoleRateLimiter {
    inner: StdRwLock<Inner>,
}

struct Inner {
    per_user: Option<Arc<KeyedLimiter>>,
    per_target: Option<Arc<KeyedLimiter>>,
}

impl SqlConsoleRateLimiter {
    pub fn new() -> Self {
        Self {
            inner: StdRwLock::new(Inner {
                per_user: None,
                per_target: None,
            }),
        }
    }

    /// Rebuilds the per-user and per-target limiters from the current
    /// `parameters` row. Discards the in-flight limiter state (quotas are
    /// rebuilt from scratch); this is acceptable for admin-initiated
    /// quota changes, which are infrequent.
    pub async fn refresh(&self, db: &SharedDatabaseConnection) -> Result<(), GatedError> {
        let params = {
            let guard = crate::db_required(db).await?;
            Parameters::Entity::get(&guard).await?
        };
        let per_user = build_keyed_limiter(params.sql_console_rate_limit_per_user);
        let per_target = build_keyed_limiter(params.sql_console_rate_limit_per_target);
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let mut inner = self.inner.write().unwrap();
        inner.per_user = per_user;
        inner.per_target = per_target;
        Ok(())
    }

    /// Non-blocking check. Returns `Ok(())` when the request is
    /// permitted, or the appropriate [`SqlConsoleRateLimitError`]
    /// otherwise. Per-user is checked before per-target so the error
    /// surfaces the user's own quota first when both are exhausted.
    ///
    /// Synchronous: the underlying `governor` limiter is lock-free and
    /// the enclosing `RwLock` only guards cheap `Arc` swaps, so this is
    /// safe to call from hot HTTP paths without `.await`.
    pub fn check(&self, user_id: Uuid, target_id: Uuid) -> Result<(), SqlConsoleRateLimitError> {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        let guard = self.inner.read().unwrap();
        if let Some(limiter) = &guard.per_user {
            if limiter.check_key(&user_id).is_err() {
                return Err(SqlConsoleRateLimitError::PerUser);
            }
        }
        if let Some(limiter) = &guard.per_target {
            if limiter.check_key(&target_id).is_err() {
                return Err(SqlConsoleRateLimitError::PerTarget);
            }
        }
        Ok(())
    }
}

impl Default for SqlConsoleRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

fn build_keyed_limiter(rpm: Option<i64>) -> Option<Arc<KeyedLimiter>> {
    let rpm = rpm.filter(|&v| v > 0)?;
    let rpm = u32::try_from(rpm).ok()?;
    let rpm = NonZeroU32::new(rpm)?;
    Some(Arc::new(KeyedLimiter::keyed(Quota::per_minute(rpm))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uuid(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    #[test]
    fn build_keyed_limiter_none_for_null_or_zero() {
        assert!(build_keyed_limiter(None).is_none());
        assert!(build_keyed_limiter(Some(0)).is_none());
        assert!(build_keyed_limiter(Some(-1)).is_none());
    }

    #[test]
    fn build_keyed_limiter_caps_excess_u32() {
        // i64::MAX does not fit u32 — should refuse rather than panic.
        assert!(build_keyed_limiter(Some(i64::from(u32::MAX) + 1)).is_none());
    }

    #[test]
    fn check_passes_when_both_limiters_absent() {
        let inner = Inner {
            per_user: None,
            per_target: None,
        };
        let limiter = SqlConsoleRateLimiter {
            inner: StdRwLock::new(inner),
        };
        for _ in 0..10 {
            limiter.check(uuid(1), uuid(2)).unwrap();
        }
    }

    #[test]
    fn per_user_limit_rejects_after_burst() {
        let inner = Inner {
            per_user: build_keyed_limiter(Some(1)),
            per_target: None,
        };
        let limiter = SqlConsoleRateLimiter {
            inner: StdRwLock::new(inner),
        };
        let user = uuid(1);
        let target = uuid(2);
        limiter.check(user, target).unwrap();
        let err = limiter
            .check(user, target)
            .expect_err("second call should be rate-limited");
        assert!(matches!(err, SqlConsoleRateLimitError::PerUser));
    }

    #[test]
    fn per_target_limit_rejects_after_burst() {
        let inner = Inner {
            per_user: None,
            per_target: build_keyed_limiter(Some(1)),
        };
        let limiter = SqlConsoleRateLimiter {
            inner: StdRwLock::new(inner),
        };
        let target = uuid(5);
        // Two different users, but the target quota is shared across them.
        limiter.check(uuid(1), target).unwrap();
        let err = limiter
            .check(uuid(2), target)
            .expect_err("second call on same target should be rate-limited");
        assert!(matches!(err, SqlConsoleRateLimitError::PerTarget));
    }
}
