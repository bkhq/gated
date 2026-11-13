//! Target reachability: a TCP connection to the target's service port, run
//! on demand by admins and on a schedule, with the last result stored in
//! `target_status`.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use futures::StreamExt;
use gated_common::TargetOptions;
use gated_db_entities::{Target, TargetStatus};
use sea_orm::sea_query::OnConflict;
use sea_orm::{DatabaseConnection, DbErr, EntityTrait, Set};
use tokio::net::TcpStream;
use tracing::warn;
use uuid::Uuid;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const CONCURRENCY: usize = 16;

/// The host and port a connection to the target goes to.
pub fn target_address(options: &TargetOptions) -> Option<(String, u16)> {
    match options {
        TargetOptions::Ssh(o) => Some((o.host.clone(), o.port)),
        TargetOptions::MySql(o) => Some((o.host.clone(), o.port)),
        TargetOptions::Postgres(o) => Some((o.host.clone(), o.port)),
        TargetOptions::Rdp(o) => Some((o.host.clone(), o.port)),
        TargetOptions::Vnc(o) => Some((o.host.clone(), o.port)),
        TargetOptions::Http(o) => {
            let url = url::Url::parse(&o.url).ok()?;
            Some((url.host_str()?.to_owned(), url.port_or_known_default()?))
        }
    }
}

/// Opens (and drops) a TCP connection; returns how long it took.
pub async fn probe(host: &str, port: u16, timeout: Duration) -> Result<Duration, String> {
    let started = Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect((host, port))).await {
        Err(_) => Err("connection timed out".into()),
        Ok(Err(error)) => Err(match error.kind() {
            std::io::ErrorKind::ConnectionRefused => "connection refused".into(),
            std::io::ErrorKind::HostUnreachable | std::io::ErrorKind::NetworkUnreachable => {
                "host unreachable".into()
            }
            _ => error.to_string(),
        }),
        Ok(Ok(_)) => Ok(started.elapsed()),
    }
}

async fn check_one(target: Target::Model, now: DateTime<Utc>) -> TargetStatus::Model {
    let address = serde_json::from_value::<TargetOptions>(target.options)
        .ok()
        .as_ref()
        .and_then(target_address);
    let result = match address {
        None => Err("no address configured".to_owned()),
        Some((host, port)) => probe(&host, port, CONNECT_TIMEOUT).await,
    };
    TargetStatus::Model {
        target_id: target.id,
        checked_at: now,
        reachable: result.is_ok(),
        latency_ms: result
            .as_ref()
            .ok()
            .map(|d| i32::try_from(d.as_millis()).unwrap_or(i32::MAX)),
        error: result.err(),
    }
}

/// Checks the targets (at most 16 at once) and stores the results.
pub async fn check_targets(
    db: &DatabaseConnection,
    targets: &[Target::Model],
) -> Result<Vec<TargetStatus::Model>, DbErr> {
    let now = Utc::now();
    let results: Vec<TargetStatus::Model> = futures::stream::iter(targets.to_vec())
        .map(|target| check_one(target, now))
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    for status in &results {
        TargetStatus::Entity::insert(TargetStatus::ActiveModel {
            target_id: Set(status.target_id),
            checked_at: Set(status.checked_at),
            reachable: Set(status.reachable),
            latency_ms: Set(status.latency_ms),
            error: Set(status.error.clone()),
        })
        .on_conflict(
            OnConflict::column(TargetStatus::Column::TargetId)
                .update_columns([
                    TargetStatus::Column::CheckedAt,
                    TargetStatus::Column::Reachable,
                    TargetStatus::Column::LatencyMs,
                    TargetStatus::Column::Error,
                ])
                .to_owned(),
        )
        .exec(db)
        .await?;
    }
    Ok(results)
}

/// The last check of every target that has one.
pub async fn all_statuses(
    db: &DatabaseConnection,
) -> Result<HashMap<Uuid, TargetStatus::Model>, DbErr> {
    Ok(TargetStatus::Entity::find()
        .all(db)
        .await?
        .into_iter()
        .map(|s| (s.target_id, s))
        .collect())
}

/// Targets never checked or last checked longer than `interval` ago.
pub async fn due_targets(
    db: &DatabaseConnection,
    interval: Duration,
    now: DateTime<Utc>,
) -> Result<Vec<Target::Model>, DbErr> {
    let statuses = all_statuses(db).await?;
    let interval = chrono::Duration::from_std(interval).unwrap_or(chrono::Duration::MAX);
    Ok(Target::Entity::find()
        .all(db)
        .await?
        .into_iter()
        .filter(|t| {
            statuses
                .get(&t.id)
                .is_none_or(|s| now - s.checked_at >= interval)
        })
        .collect())
}

/// One scheduler pass: checks the due targets if automatic checks are on.
pub async fn run_scheduled_checks(db: &DatabaseConnection) -> Result<usize, DbErr> {
    let hours = gated_db_entities::Parameters::Entity::get(db)
        .await?
        .target_check_interval_hours;
    let Ok(hours) = u64::try_from(hours) else {
        return Ok(0);
    };
    if hours == 0 {
        return Ok(0);
    }
    let due = due_targets(db, Duration::from_secs(hours * 3600), Utc::now()).await?;
    if due.is_empty() {
        return Ok(0);
    }
    let results = check_targets(db, &due).await?;
    let down = results.iter().filter(|s| !s.reachable).count();
    if down > 0 {
        warn!(
            checked = results.len(),
            down, "Scheduled target check found unreachable targets"
        );
    }
    Ok(results.len())
}

/// How often the scheduler looks for due targets.
const SCHEDULER_TICK: Duration = Duration::from_secs(60);

/// Checks due targets every minute; idle while the database is locked.
pub async fn run_scheduler(services: crate::Services) {
    loop {
        tokio::time::sleep(SCHEDULER_TICK).await;
        let Ok(db) = services.db_required().await else {
            continue;
        };
        if let Err(error) = run_scheduled_checks(&db).await {
            warn!(%error, "Scheduled target check failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use gated_db_entities::Target::TargetKind;
    use sea_orm::{ActiveModelTrait, Database};
    use tokio::net::TcpListener;

    use super::*;

    async fn db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("test");
        gated_db_migrations::migrate_database(&db)
            .await
            .expect("test");
        db
    }

    async fn ssh_target(db: &DatabaseConnection, name: &str, port: u16) -> Target::Model {
        let options = serde_json::json!({ "ssh": { "host": "127.0.0.1", "port": port } });
        Target::ActiveModel {
            id: Set(Uuid::new_v4()),
            name: Set(name.into()),
            description: Set(String::new()),
            kind: Set(TargetKind::Ssh),
            options: Set(options),
            rate_limit_bytes_per_second: Set(None),
            group_id: Set(None),
        }
        .insert(db)
        .await
        .expect("test")
    }

    async fn closed_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("test");
        listener.local_addr().expect("test").port()
    }

    fn options(value: serde_json::Value) -> TargetOptions {
        serde_json::from_value(value).expect("test")
    }

    #[test]
    fn address_per_kind() {
        let ssh = options(serde_json::json!({ "ssh": { "host": "box", "port": 2222 } }));
        assert_eq!(target_address(&ssh), Some(("box".into(), 2222)));
        let http = |url: &str| options(serde_json::json!({ "http": { "url": url } }));
        assert_eq!(
            target_address(&http("https://web.local/app")),
            Some(("web.local".into(), 443))
        );
        assert_eq!(
            target_address(&http("http://web.local:8080")),
            Some(("web.local".into(), 8080))
        );
        assert_eq!(target_address(&http("not a url")), None);
    }

    #[tokio::test]
    async fn probe_reports_open_and_closed_ports() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("test");
        let open = listener.local_addr().expect("test").port();
        assert!(probe("127.0.0.1", open, CONNECT_TIMEOUT).await.is_ok());
        drop(listener);
        assert_eq!(
            probe("127.0.0.1", closed_port().await, CONNECT_TIMEOUT).await,
            Err("connection refused".into())
        );
    }

    #[tokio::test]
    async fn check_stores_the_latest_result() {
        let db = db().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("test");
        let up = ssh_target(&db, "up", listener.local_addr().expect("test").port()).await;
        let down = ssh_target(&db, "down", closed_port().await).await;

        check_targets(&db, &[up.clone(), down.clone()])
            .await
            .expect("test");
        let statuses = all_statuses(&db).await.expect("test");
        assert!(statuses[&up.id].reachable);
        assert!(statuses[&up.id].latency_ms.is_some());
        assert!(!statuses[&down.id].reachable);
        assert_eq!(
            statuses[&down.id].error.as_deref(),
            Some("connection refused")
        );

        // A second check replaces the row.
        drop(listener);
        check_targets(&db, std::slice::from_ref(&up))
            .await
            .expect("test");
        let statuses = all_statuses(&db).await.expect("test");
        assert_eq!(statuses.len(), 2);
        assert!(!statuses[&up.id].reachable);
    }

    #[tokio::test]
    async fn due_targets_are_unchecked_or_stale() {
        let db = db().await;
        let fresh = ssh_target(&db, "fresh", closed_port().await).await;
        let never = ssh_target(&db, "never", closed_port().await).await;
        check_targets(&db, std::slice::from_ref(&fresh))
            .await
            .expect("test");

        let hour = Duration::from_secs(3600);
        let due = due_targets(&db, hour, Utc::now()).await.expect("test");
        assert_eq!(due.iter().map(|t| t.id).collect::<Vec<_>>(), vec![never.id]);

        let later = Utc::now() + chrono::Duration::hours(2);
        assert_eq!(due_targets(&db, hour, later).await.expect("test").len(), 2);
    }

    #[tokio::test]
    async fn scheduled_checks_follow_the_interval_setting() {
        let db = db().await;
        ssh_target(&db, "a", closed_port().await).await;
        assert_eq!(run_scheduled_checks(&db).await.expect("test"), 1);
        // Checked just now: not due again within the default 24 h.
        assert_eq!(run_scheduled_checks(&db).await.expect("test"), 0);

        let mut parameters: gated_db_entities::Parameters::ActiveModel =
            gated_db_entities::Parameters::Entity::get(&db)
                .await
                .expect("test")
                .into();
        parameters.target_check_interval_hours = Set(0);
        parameters.update(&db).await.expect("test");
        ssh_target(&db, "b", closed_port().await).await;
        assert_eq!(run_scheduled_checks(&db).await.expect("test"), 0);
    }
}
