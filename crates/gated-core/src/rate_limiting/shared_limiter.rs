use std::fmt::Debug;
use std::ops::{Deref, DerefMut};
use std::sync::Arc;

use super::GatedRateLimiter;

#[derive(Clone, Debug)]
pub struct SharedGatedRateLimiter {
    inner: Arc<std::sync::Mutex<GatedRateLimiter>>,
}

impl SharedGatedRateLimiter {
    pub(crate) fn new(limiter: GatedRateLimiter) -> Self {
        Self {
            inner: Arc::new(std::sync::Mutex::new(limiter)),
        }
    }

    pub fn lock(&self) -> SharedGatedRateLimiterGuard<'_> {
        #[allow(clippy::unwrap_used, reason = "panic on poison")]
        SharedGatedRateLimiterGuard::new(self.inner.lock().unwrap())
    }
}

/// Encapsulates a shared reference to a `GatedRateLimiter` in a mutex
/// and prevents locks from being sent across awaits
pub struct SharedGatedRateLimiterGuard<'a> {
    inner: std::sync::MutexGuard<'a, GatedRateLimiter>,
    // prevent locks across awaits
    _non_sendable: std::marker::PhantomData<*const ()>,
}

impl<'a> SharedGatedRateLimiterGuard<'a> {
    pub fn new(inner: std::sync::MutexGuard<'a, GatedRateLimiter>) -> Self {
        Self {
            inner,
            _non_sendable: std::marker::PhantomData,
        }
    }
}

impl Deref for SharedGatedRateLimiterGuard<'_> {
    type Target = GatedRateLimiter;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl DerefMut for SharedGatedRateLimiterGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}
