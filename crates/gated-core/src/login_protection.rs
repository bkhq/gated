//! Address blocks and user lockouts after repeated failed sign-ins, stored
//! in the database so they survive a restart and an administrator can list
//! and lift them. The in-memory limits of `auth_throttle` stay in front.

use std::net::IpAddr;

use chrono::{DateTime, Duration, Utc};
use gated_common::GatedError;
use gated_db_entities::{
    FailedLoginAttempt, IpBlock, Parameters, Role, User, UserLockout, UserRoleAssignment,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, Set,
};
use tracing::warn;
use uuid::Uuid;

use crate::consts::BUILTIN_ADMIN_ROLE_NAME;

const MAX_NAME_LEN: usize = 256;
/// An address that stays quiet this long after a block starts over with the
/// shortest block; failed attempts are also forgotten after this long.
const RETENTION: Duration = Duration::hours(24);

/// Why a sign-in attempt is refused before the credential is looked at.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    IpBlocked,
    UserLocked,
}

/// The client address as a block key. With a trusted `X-Forwarded-For`
/// list this is the last entry, the one the nearest proxy added; the
/// entries before it are whatever the client sent.
pub fn parse_client_ip(client: &str) -> Option<IpAddr> {
    client
        .rsplit(',')
        .next()?
        .trim()
        .parse::<IpAddr>()
        .ok()
        .map(|ip| ip.to_canonical())
}

fn name_key(username: &str) -> String {
    username.chars().take(MAX_NAME_LEN).collect()
}

fn seconds(value: i32) -> Duration {
    Duration::seconds(i64::from(value.max(0)))
}

/// `base * 2^(block_count - 1)`, at most `max`.
fn block_duration(block_count: i32, base: i32, max: i32) -> Duration {
    let doublings = u32::try_from(block_count.saturating_sub(1)).unwrap_or(0);
    let factor = 2_i64.checked_pow(doublings).unwrap_or(i64::MAX);
    let secs = i64::from(base.max(0)).saturating_mul(factor);
    Duration::seconds(secs.min(i64::from(max.max(base).max(0))))
}

pub async fn refusal(
    db: &DatabaseConnection,
    ip: Option<IpAddr>,
    username: &str,
) -> Result<Option<Refusal>, GatedError> {
    refusal_at(db, ip, username, Utc::now()).await
}

async fn refusal_at(
    db: &DatabaseConnection,
    ip: Option<IpAddr>,
    username: &str,
    now: DateTime<Utc>,
) -> Result<Option<Refusal>, GatedError> {
    if !Parameters::Entity::get(db).await?.login_protection_enabled {
        return Ok(None);
    }
    if let Some(ip) = ip
        && IpBlock::Entity::find_by_id(ip.to_string())
            .filter(IpBlock::Column::ExpiresAt.gt(now))
            .one(db)
            .await?
            .is_some()
    {
        return Ok(Some(Refusal::IpBlocked));
    }
    let locked = UserLockout::Entity::find_by_id(name_key(username))
        .one(db)
        .await?
        .is_some_and(|lockout| lockout.expires_at.is_none_or(|expires| expires > now));
    Ok(locked.then_some(Refusal::UserLocked))
}

/// Counts a failed attempt and blocks the address or locks the user when a
/// threshold is reached.
pub async fn record_failure(
    db: &DatabaseConnection,
    ip: Option<IpAddr>,
    username: &str,
) -> Result<(), GatedError> {
    record_failure_at(db, ip, username, Utc::now()).await
}

async fn record_failure_at(
    db: &DatabaseConnection,
    ip: Option<IpAddr>,
    username: &str,
    now: DateTime<Utc>,
) -> Result<(), GatedError> {
    let params = Parameters::Entity::get(db).await?;
    if !params.login_protection_enabled {
        return Ok(());
    }
    let username = name_key(username);
    let ip = ip.map(|ip| ip.to_string());

    FailedLoginAttempt::Entity::delete_many()
        .filter(FailedLoginAttempt::Column::Timestamp.lt(now - RETENTION))
        .exec(db)
        .await?;
    FailedLoginAttempt::ActiveModel {
        id: Set(Uuid::new_v4()),
        username: Set(username.clone()),
        remote_ip: Set(ip.clone()),
        timestamp: Set(now),
    }
    .insert(db)
    .await?;

    if let Some(ip) = ip {
        let failures = FailedLoginAttempt::Entity::find()
            .filter(FailedLoginAttempt::Column::RemoteIp.eq(&ip))
            .filter(
                FailedLoginAttempt::Column::Timestamp
                    .gt(now - seconds(params.lp_ip_window_seconds)),
            )
            .count(db)
            .await?;
        if failures >= u64::try_from(params.lp_ip_max_attempts.max(1)).unwrap_or(1) {
            block_ip(db, &ip, &params, now).await?;
        }
    }

    let failures = FailedLoginAttempt::Entity::find()
        .filter(FailedLoginAttempt::Column::Username.eq(&username))
        .filter(
            FailedLoginAttempt::Column::Timestamp.gt(now - seconds(params.lp_user_window_seconds)),
        )
        .count(db)
        .await?;
    if failures >= u64::try_from(params.lp_user_max_attempts.max(1)).unwrap_or(1)
        && can_be_locked(db, &username).await?
    {
        lock_user(db, &username, &params, now).await?;
    }
    Ok(())
}

async fn block_ip(
    db: &DatabaseConnection,
    ip: &str,
    params: &Parameters::Model,
    now: DateTime<Utc>,
) -> Result<(), GatedError> {
    let previous = IpBlock::Entity::find_by_id(ip).one(db).await?;
    let block_count = match &previous {
        Some(previous) if now - previous.expires_at <= RETENTION => {
            previous.block_count.saturating_add(1)
        }
        _ => 1,
    };
    let expires_at = now
        + block_duration(
            block_count,
            params.lp_ip_block_seconds,
            params.lp_ip_max_block_seconds,
        );
    let model = IpBlock::ActiveModel {
        ip_address: Set(ip.to_owned()),
        block_count: Set(block_count),
        blocked_at: Set(now),
        expires_at: Set(expires_at),
    };
    if previous.is_some() {
        model.update(db).await?;
    } else {
        model.insert(db).await?;
    }
    // The count starts again when the block ends.
    FailedLoginAttempt::Entity::delete_many()
        .filter(FailedLoginAttempt::Column::RemoteIp.eq(ip))
        .exec(db)
        .await?;
    warn!(target: "audit", client_ip = %ip, block_count, %expires_at, "login_ip_blocked");
    Ok(())
}

/// Unknown names have nothing to lock, and administrators are never locked:
/// anyone who knows the name could otherwise keep them out. Address blocks
/// and the in-memory per-user limit still apply to them.
async fn can_be_locked(db: &DatabaseConnection, username: &str) -> Result<bool, GatedError> {
    let Some(user) = User::Entity::find()
        .filter(User::Column::Username.eq(username))
        .one(db)
        .await?
    else {
        return Ok(false);
    };
    let Some(admin_role) = Role::Entity::find()
        .filter(Role::Column::Name.eq(BUILTIN_ADMIN_ROLE_NAME))
        .one(db)
        .await?
    else {
        return Ok(true);
    };
    let is_admin = UserRoleAssignment::Entity::find()
        .filter(UserRoleAssignment::Column::UserId.eq(user.id))
        .filter(UserRoleAssignment::Column::RoleId.eq(admin_role.id))
        .filter(UserRoleAssignment::Entity::unexpired())
        .one(db)
        .await?
        .is_some();
    Ok(!is_admin)
}

async fn lock_user(
    db: &DatabaseConnection,
    username: &str,
    params: &Parameters::Model,
    now: DateTime<Utc>,
) -> Result<(), GatedError> {
    let expires_at =
        (params.lp_user_lockout_seconds > 0).then(|| now + seconds(params.lp_user_lockout_seconds));
    UserLockout::Entity::delete_by_id(username).exec(db).await?;
    UserLockout::ActiveModel {
        username: Set(username.to_owned()),
        locked_at: Set(now),
        expires_at: Set(expires_at),
    }
    .insert(db)
    .await?;
    FailedLoginAttempt::Entity::delete_many()
        .filter(FailedLoginAttempt::Column::Username.eq(username))
        .exec(db)
        .await?;
    warn!(target: "audit", %username, ?expires_at, "login_user_locked");
    Ok(())
}

/// Blocks in force, newest first.
pub async fn list_ip_blocks(db: &DatabaseConnection) -> Result<Vec<IpBlock::Model>, GatedError> {
    Ok(IpBlock::Entity::find()
        .filter(IpBlock::Column::ExpiresAt.gt(Utc::now()))
        .order_by_desc(IpBlock::Column::BlockedAt)
        .all(db)
        .await?)
}

/// Lockouts in force, newest first.
pub async fn list_user_lockouts(
    db: &DatabaseConnection,
) -> Result<Vec<UserLockout::Model>, GatedError> {
    Ok(UserLockout::Entity::find()
        .filter(
            UserLockout::Column::ExpiresAt
                .is_null()
                .or(UserLockout::Column::ExpiresAt.gt(Utc::now())),
        )
        .order_by_desc(UserLockout::Column::LockedAt)
        .all(db)
        .await?)
}

/// Lifts a block and forgets the address's history. `false`: no such block.
pub async fn unblock_ip(db: &DatabaseConnection, ip: &str) -> Result<bool, GatedError> {
    FailedLoginAttempt::Entity::delete_many()
        .filter(FailedLoginAttempt::Column::RemoteIp.eq(ip))
        .exec(db)
        .await?;
    let deleted = IpBlock::Entity::delete_by_id(ip).exec(db).await?;
    Ok(deleted.rows_affected > 0)
}

/// Lifts a lockout and forgets the user's failed attempts. `false`: the
/// user was not locked.
pub async fn unlock_user(db: &DatabaseConnection, username: &str) -> Result<bool, GatedError> {
    FailedLoginAttempt::Entity::delete_many()
        .filter(FailedLoginAttempt::Column::Username.eq(username))
        .exec(db)
        .await?;
    let deleted = UserLockout::Entity::delete_by_id(username).exec(db).await?;
    Ok(deleted.rows_affected > 0)
}

#[cfg(test)]
mod tests {
    use sea_orm::{Database, IntoActiveModel};

    use super::*;

    async fn db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("test");
        gated_db_migrations::migrate_database(&db)
            .await
            .expect("test");
        let mut params = Parameters::Entity::get(&db)
            .await
            .expect("test")
            .into_active_model();
        params.lp_ip_max_attempts = Set(3);
        params.lp_user_max_attempts = Set(4);
        params.update(&db).await.expect("test");
        db
    }

    async fn user(db: &DatabaseConnection, username: &str, admin: bool) {
        let id = Uuid::new_v4();
        User::ActiveModel {
            id: Set(id),
            username: Set(username.into()),
            description: Set(String::new()),
            credential_policy: Set(serde_json::Value::Null),
            rate_limit_bytes_per_second: Set(None),
            allowed_ip_ranges: Set(None),
        }
        .insert(db)
        .await
        .expect("test");
        if admin {
            let role_id = Uuid::new_v4();
            Role::ActiveModel {
                id: Set(role_id),
                name: Set(BUILTIN_ADMIN_ROLE_NAME.into()),
                description: Set(String::new()),
                allow_file_transfer: Set(true),
                allow_clipboard: Set(false),
            }
            .insert(db)
            .await
            .expect("test");
            UserRoleAssignment::ActiveModel {
                user_id: Set(id),
                role_id: Set(role_id),
                ..Default::default()
            }
            .insert(db)
            .await
            .expect("test");
        }
    }

    fn ip(s: &str) -> Option<IpAddr> {
        parse_client_ip(s)
    }

    #[test]
    fn the_client_ip_is_the_entry_the_nearest_proxy_added() {
        assert_eq!(ip("10.0.0.1"), "10.0.0.1".parse().ok());
        assert_eq!(ip("6.6.6.6, 10.0.0.1"), "10.0.0.1".parse().ok());
        assert_eq!(ip("::ffff:10.0.0.1"), "10.0.0.1".parse().ok());
        assert_eq!(ip("<unknown>"), None);
    }

    #[test]
    fn repeat_blocks_double_up_to_the_cap() {
        assert_eq!(block_duration(1, 1800, 86400), Duration::seconds(1800));
        assert_eq!(block_duration(2, 1800, 86400), Duration::seconds(3600));
        assert_eq!(block_duration(3, 1800, 86400), Duration::seconds(7200));
        assert_eq!(block_duration(10, 1800, 86400), Duration::seconds(86400));
        assert_eq!(block_duration(500, 1800, 86400), Duration::seconds(86400));
        assert_eq!(block_duration(0, 1800, 86400), Duration::seconds(1800));
        assert_eq!(block_duration(2, 1800, 60), Duration::seconds(1800));
    }

    #[tokio::test]
    async fn an_address_is_blocked_at_the_threshold_and_longer_the_next_time() {
        let db = db().await;
        let now = Utc::now();
        let addr = ip("10.0.0.1");
        for name in ["a", "b"] {
            record_failure_at(&db, addr, name, now).await.expect("test");
            assert_eq!(refusal_at(&db, addr, name, now).await.expect("test"), None);
        }
        record_failure_at(&db, addr, "c", now).await.expect("test");
        assert_eq!(
            refusal_at(&db, addr, "anyone", now).await.expect("test"),
            Some(Refusal::IpBlocked)
        );
        assert_eq!(
            refusal_at(&db, ip("10.0.0.2"), "a", now)
                .await
                .expect("test"),
            None
        );
        assert_eq!(list_ip_blocks(&db).await.expect("test").len(), 1);

        // The block ends; the count starts again, and the next block is longer.
        let later = now + Duration::seconds(1801);
        assert_eq!(refusal_at(&db, addr, "a", later).await.expect("test"), None);
        for _ in 0..3 {
            record_failure_at(&db, addr, "a", later)
                .await
                .expect("test");
        }
        let block = IpBlock::Entity::find_by_id("10.0.0.1")
            .one(&db)
            .await
            .expect("test")
            .expect("test");
        assert_eq!(block.block_count, 2);
        assert_eq!(block.expires_at - block.blocked_at, Duration::seconds(3600));

        // A day of quiet after a block resets the escalation.
        let much_later = block.expires_at + RETENTION + Duration::seconds(1);
        for _ in 0..3 {
            record_failure_at(&db, addr, "a", much_later)
                .await
                .expect("test");
        }
        let block = IpBlock::Entity::find_by_id("10.0.0.1")
            .one(&db)
            .await
            .expect("test")
            .expect("test");
        assert_eq!(block.block_count, 1);
    }

    #[tokio::test]
    async fn failures_outside_the_window_do_not_count() {
        let db = db().await;
        let now = Utc::now();
        let addr = ip("10.0.0.1");
        record_failure_at(&db, addr, "a", now).await.expect("test");
        record_failure_at(&db, addr, "a", now).await.expect("test");
        let later = now + Duration::seconds(901);
        record_failure_at(&db, addr, "a", later)
            .await
            .expect("test");
        assert_eq!(refusal_at(&db, addr, "a", later).await.expect("test"), None);
    }

    #[tokio::test]
    async fn a_user_is_locked_from_every_address_until_the_lockout_ends() {
        let db = db().await;
        user(&db, "alice", false).await;
        let now = Utc::now();
        for i in 0..4 {
            assert_eq!(
                refusal_at(&db, ip("10.9.9.9"), "alice", now)
                    .await
                    .expect("test"),
                None
            );
            record_failure_at(&db, ip(&format!("10.0.0.{i}")), "alice", now)
                .await
                .expect("test");
        }
        assert_eq!(
            refusal_at(&db, ip("10.9.9.9"), "alice", now)
                .await
                .expect("test"),
            Some(Refusal::UserLocked)
        );
        assert_eq!(
            refusal_at(&db, None, "alice", now).await.expect("test"),
            Some(Refusal::UserLocked)
        );
        assert_eq!(list_user_lockouts(&db).await.expect("test").len(), 1);
        assert_eq!(
            refusal_at(&db, ip("10.9.9.9"), "alice", now + Duration::seconds(3601))
                .await
                .expect("test"),
            None
        );
    }

    #[tokio::test]
    async fn a_lockout_without_duration_lasts_until_it_is_lifted() {
        let db = db().await;
        user(&db, "alice", false).await;
        let mut params = Parameters::Entity::get(&db)
            .await
            .expect("test")
            .into_active_model();
        params.lp_user_lockout_seconds = Set(0);
        params.update(&db).await.expect("test");
        let now = Utc::now();
        for _ in 0..4 {
            record_failure_at(&db, None, "alice", now)
                .await
                .expect("test");
        }
        let far = now + Duration::days(3650);
        assert_eq!(
            refusal_at(&db, None, "alice", far).await.expect("test"),
            Some(Refusal::UserLocked)
        );
        assert!(unlock_user(&db, "alice").await.expect("test"));
        assert!(!unlock_user(&db, "alice").await.expect("test"));
        assert_eq!(
            refusal_at(&db, None, "alice", far).await.expect("test"),
            None
        );
    }

    #[tokio::test]
    async fn administrators_and_unknown_names_are_not_locked() {
        let db = db().await;
        user(&db, "root", true).await;
        let now = Utc::now();
        for name in ["root", "nobody"] {
            for _ in 0..6 {
                record_failure_at(&db, None, name, now).await.expect("test");
            }
            assert_eq!(refusal_at(&db, None, name, now).await.expect("test"), None);
        }
        assert!(list_user_lockouts(&db).await.expect("test").is_empty());
    }

    #[tokio::test]
    async fn lifting_a_block_admits_the_address_again() {
        let db = db().await;
        let now = Utc::now();
        let addr = ip("10.0.0.1");
        for _ in 0..3 {
            record_failure_at(&db, addr, "a", now).await.expect("test");
        }
        assert!(unblock_ip(&db, "10.0.0.1").await.expect("test"));
        assert!(!unblock_ip(&db, "10.0.0.1").await.expect("test"));
        assert_eq!(refusal_at(&db, addr, "a", now).await.expect("test"), None);
    }

    #[tokio::test]
    async fn nothing_is_counted_when_switched_off() {
        let db = db().await;
        let mut params = Parameters::Entity::get(&db)
            .await
            .expect("test")
            .into_active_model();
        params.login_protection_enabled = Set(false);
        params.update(&db).await.expect("test");
        let now = Utc::now();
        for _ in 0..5 {
            record_failure_at(&db, ip("10.0.0.1"), "a", now)
                .await
                .expect("test");
        }
        assert_eq!(
            refusal_at(&db, ip("10.0.0.1"), "a", now)
                .await
                .expect("test"),
            None
        );
        assert_eq!(
            FailedLoginAttempt::Entity::find()
                .count(&db)
                .await
                .expect("test"),
            0
        );
    }
}
