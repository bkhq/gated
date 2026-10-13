use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use gated_common::auth::{AuthResult, AuthState, CredentialKind};
use gated_common::{GatedError, SessionId};
use once_cell::sync::Lazy;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::{ConfigProvider, ConfigProviderEnum};

pub static TIMEOUT: Lazy<Duration> = Lazy::new(|| Duration::from_secs(60 * 10));

/// How long an `action=review` command-review request stays pending before it
/// is treated as a reject (audit outcome `review-timeout`). The paused SSH
/// session waits at most this long for an admin decision.
///
/// Bounded and configurable: `GATED_COMMAND_REVIEW_TIMEOUT_SECS` (a positive
/// integer) overrides the 5-minute default. Read once on first use.
pub static COMMAND_REVIEW_TIMEOUT: Lazy<Duration> = Lazy::new(|| {
    let secs = std::env::var("GATED_COMMAND_REVIEW_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&s| s > 0)
        .unwrap_or(60 * 5);
    Duration::from_secs(secs)
});

/// The admin's verdict on a pending command review.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandReviewDecision {
    Approved,
    Rejected,
}

/// A pending interactive command review. When an SSH `exec`
/// command matches an `action=review` ACL rule the session pauses and registers
/// one of these; an admin lists and approves/rejects it, releasing the paused
/// session. Carries only the command text and the context needed to display and
/// audit the decision (no credential policy / `AuthState`).
#[derive(Clone, Debug)]
pub struct CommandReviewInfo {
    pub id: Uuid,
    pub session_id: Option<SessionId>,
    pub user_id: Option<Uuid>,
    pub username: Option<String>,
    pub target_id: Option<Uuid>,
    pub target_name: String,
    /// Always `"exec"` today — the guaranteed-flow path. PTY review stays a
    /// fail-safe block and never reaches this store.
    pub origin: String,
    pub command: String,
    pub acl_rule_id: Option<i64>,
    pub acl_rule_name: Option<String>,
    pub requested_at: DateTime<Utc>,
}

struct PendingCommandReview {
    info: CommandReviewInfo,
    sender: broadcast::Sender<CommandReviewDecision>,
    created_at: Instant,
}

/// Holds command-review requests that are paused awaiting an admin decision.
///
/// Mirrors [`AuthStateStore`]'s create/subscribe/complete + broadcast shape but
/// is deliberately a separate, simpler store (see [`CommandReviewInfo`]).
/// Feature is OFF by default: with no `action=review` rule this store is never
/// populated and behaviour is unchanged.
#[derive(Default)]
pub struct CommandReviewStore {
    pending: HashMap<Uuid, PendingCommandReview>,
}

impl CommandReviewStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a pending review and return the receiver the paused session
    /// awaits. `info.id` identifies the request for the admin list/decision
    /// endpoints. A bounded-capacity channel is fine: exactly one decision is
    /// ever sent per request.
    pub fn create(&mut self, info: CommandReviewInfo) -> broadcast::Receiver<CommandReviewDecision> {
        let (sender, receiver) = broadcast::channel(1);
        self.pending.insert(
            info.id,
            PendingCommandReview {
                info,
                sender,
                created_at: Instant::now(),
            },
        );
        receiver
    }

    /// Snapshot of all pending reviews, newest last (stable by request time).
    pub fn list(&self) -> Vec<CommandReviewInfo> {
        let mut items: Vec<CommandReviewInfo> =
            self.pending.values().map(|p| p.info.clone()).collect();
        items.sort_by_key(|i| i.requested_at);
        items
    }

    /// Resolve a pending review: send the decision to the paused session and
    /// drop the entry. Returns `true` if a matching request existed.
    pub fn complete(&mut self, id: &Uuid, decision: CommandReviewDecision) -> bool {
        let Some(pending) = self.pending.remove(id) else {
            return false;
        };
        let _ = pending.sender.send(decision);
        true
    }

    /// Drop a pending review without signalling (used by the session to clean
    /// up after a timeout). The awaiting receiver then observes a closed
    /// channel, which the session treats as a timeout/reject.
    pub fn remove(&mut self, id: &Uuid) {
        self.pending.remove(id);
    }

    /// Drop reviews older than [`COMMAND_REVIEW_TIMEOUT`]. Dropping the entry
    /// closes the sender, releasing any still-paused session as a timeout.
    pub fn vacuum(&mut self) {
        self.pending
            .retain(|_, p| p.created_at.elapsed() < *COMMAND_REVIEW_TIMEOUT);
    }
}

#[cfg(test)]
mod command_review_tests {
    use super::*;

    fn info(id: Uuid, command: &str) -> CommandReviewInfo {
        CommandReviewInfo {
            id,
            session_id: None,
            user_id: None,
            username: Some("alice".into()),
            target_id: None,
            target_name: "web".into(),
            origin: "exec".into(),
            command: command.into(),
            acl_rule_id: Some(1),
            acl_rule_name: Some("review-rule".into()),
            requested_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn approve_releases_paused_receiver() {
        let mut store = CommandReviewStore::new();
        let id = Uuid::new_v4();
        let mut rx = store.create(info(id, "hostname"));

        assert_eq!(store.list().len(), 1);
        assert!(store.complete(&id, CommandReviewDecision::Approved));
        assert_eq!(rx.recv().await.unwrap(), CommandReviewDecision::Approved);
        // Entry is gone; a second decision finds nothing.
        assert!(store.list().is_empty());
        assert!(!store.complete(&id, CommandReviewDecision::Approved));
    }

    #[tokio::test]
    async fn reject_releases_with_rejected() {
        let mut store = CommandReviewStore::new();
        let id = Uuid::new_v4();
        let mut rx = store.create(info(id, "rm -rf /"));

        assert!(store.complete(&id, CommandReviewDecision::Rejected));
        assert_eq!(rx.recv().await.unwrap(), CommandReviewDecision::Rejected);
    }

    #[tokio::test]
    async fn remove_closes_channel_like_a_timeout() {
        let mut store = CommandReviewStore::new();
        let id = Uuid::new_v4();
        let mut rx = store.create(info(id, "hostname"));

        // Dropping the entry without a decision (timeout/vacuum) closes the
        // sender: the awaiting session observes a RecvError and fails safe.
        store.remove(&id);
        assert!(rx.recv().await.is_err());
        assert!(store.list().is_empty());
    }

    #[test]
    fn complete_unknown_id_is_false() {
        let mut store = CommandReviewStore::new();
        assert!(!store.complete(&Uuid::new_v4(), CommandReviewDecision::Approved));
    }
}

struct AuthCompletionSignal {
    sender: broadcast::Sender<AuthResult>,
    created_at: Instant,
}

impl AuthCompletionSignal {
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() > *TIMEOUT
    }
}

pub struct AuthStateStore {
    config_provider: Arc<Mutex<ConfigProviderEnum>>,
    store: HashMap<Uuid, (Arc<Mutex<AuthState>>, Instant)>,
    completion_signals: HashMap<Uuid, AuthCompletionSignal>,
    web_auth_request_signal: broadcast::Sender<Uuid>,
}

impl AuthStateStore {
    pub fn new(config_provider: Arc<Mutex<ConfigProviderEnum>>) -> Self {
        Self {
            store: HashMap::new(),
            config_provider,
            completion_signals: HashMap::new(),
            web_auth_request_signal: broadcast::channel(100).0,
        }
    }

    pub fn contains_key(&self, id: &Uuid) -> bool {
        self.store.contains_key(id)
    }

    pub async fn all_pending_web_auths_for_user(
        &self,
        username: &str,
    ) -> Vec<Arc<Mutex<AuthState>>> {
        let mut results = vec![];
        for auth in self.store.values() {
            {
                let inner = auth.0.lock().await;
                if inner.user_info().username != username {
                    continue;
                }
                let AuthResult::Need(need) = inner.verify() else {
                    continue;
                };
                if !need.contains(&CredentialKind::WebUserApproval) {
                    continue;
                }
            }
            results.push(auth.0.clone())
        }
        results
    }

    pub fn get(&self, id: &Uuid) -> Option<Arc<Mutex<AuthState>>> {
        self.store.get(id).map(|x| x.0.clone())
    }

    pub fn subscribe_web_auth_request(&self) -> broadcast::Receiver<Uuid> {
        self.web_auth_request_signal.subscribe()
    }

    pub async fn create(
        &mut self,
        session_id: Option<&SessionId>,
        username: &str,
        protocol: &str,
        supported_credential_types: &[CredentialKind],
    ) -> Result<(Uuid, Arc<Mutex<AuthState>>), GatedError> {
        let id = Uuid::new_v4();

        let Some(user) = self
            .config_provider
            .lock()
            .await
            .list_users()
            .await?
            .iter()
            .find(|u| u.username == username)
            .cloned()
        else {
            return Err(GatedError::UserNotFound(username.into()));
        };

        let policy = self
            .config_provider
            .lock()
            .await
            .get_credential_policy(username, supported_credential_types)
            .await?;
        let Some(policy) = policy else {
            return Err(GatedError::UserNotFound(username.into()));
        };

        let (state_change_tx, mut state_change_rx) = broadcast::channel(1);
        let web_auth_request_signal = self.web_auth_request_signal.clone();
        tokio::spawn(async move {
            while let Ok(AuthResult::Need(result)) = state_change_rx.recv().await {
                if result.contains(&CredentialKind::WebUserApproval) {
                    let _ = web_auth_request_signal.send(id);
                }
            }
        });

        let state = AuthState::new(
            id,
            session_id.copied(),
            (&user).into(),
            protocol.to_string(),
            policy,
            state_change_tx,
        );
        self.store
            .insert(id, (Arc::new(Mutex::new(state)), Instant::now()));

        #[allow(clippy::unwrap_used, reason = "inserted on the previous line")]
        Ok((id, self.get(&id).unwrap()))
    }

    pub fn subscribe(&mut self, id: Uuid) -> broadcast::Receiver<AuthResult> {
        let signal = self.completion_signals.entry(id).or_insert_with(|| {
            let (sender, _) = broadcast::channel(1);
            AuthCompletionSignal {
                sender,
                created_at: Instant::now(),
            }
        });

        signal.sender.subscribe()
    }

    pub async fn complete(&mut self, id: &Uuid) {
        let Some((state, _)) = self.store.get(id) else {
            return;
        };
        if let Some(sig) = self.completion_signals.remove(id) {
            let _ = sig.sender.send(state.lock().await.verify());
        }
    }

    pub async fn vacuum(&mut self) {
        self.store
            .retain(|_, (_, started_at)| started_at.elapsed() < *TIMEOUT);

        self.completion_signals
            .retain(|_, signal| !signal.is_expired());
    }
}
