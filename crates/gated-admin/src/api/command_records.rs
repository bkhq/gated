//! Admin API to query/search structured command records.
//!
//! Two structured recording streams are persisted by the recorders in
//! `gated_core::recordings::structured`: shell-command audits
//! ([`RecordingKind::CommandAudit`], written by `CommandAuditRecorder`) and SQL
//! proxy/console audits ([`RecordingKind::SqlAudit`], written by
//! `SqlAuditRecorder`). This endpoint reads both back through the existing
//! recordings store and merges them into one unified, filterable list.
//!
//! Mounted under the `/admin/api` tree, which is wrapped in
//! `endpoint_auth(endpoint_admin_auth(..))` (see `http_service/mod.rs`), so
//! every route here is admin-gated; a non-admin caller is rejected with 403
//! before reaching this handler. This API is read-only — it never creates or
//! mutates recordings.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_core::recordings::{SessionRecordings, ShellCommandRecordingItem, SqlAuditRecordingItem};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::Recording::{self, RecordingKind};
use gated_db_entities::Session;
use poem::web::Data;
use poem_openapi::param::Query;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;

use super::AnySecurityScheme;

/// One command record, unified across the shell-command and SQL audit streams.
///
/// `source` discriminates the origin (`"shell"` | `"sql"`). Shell records carry
/// the full command-ACL verdict (`acl_action`, `acl_rule_id`, `acl_rule_name`,
/// `outcome`); SQL records carry `success`/`error` instead and have those ACL
/// fields left null. Fields absent from a given source are `null` rather than
/// dropped so the shape round-trips both item kinds losslessly.
#[derive(Object, Clone)]
pub struct CommandRecord {
    /// `"shell"` | `"sql"`.
    source: String,
    timestamp: DateTime<Utc>,
    session_id: Uuid,
    target: Option<String>,
    target_id: Option<Uuid>,
    user_id: Option<Uuid>,
    username: Option<String>,
    /// The shell command line or the SQL query text.
    command: String,
    /// Shell only: `"exec"` | `"pty"`.
    origin: Option<String>,
    /// Shell command-ACL verdict: `"allow"` | `"deny"` | `"review"`.
    acl_action: Option<String>,
    acl_rule_id: Option<i64>,
    acl_rule_name: Option<String>,
    /// Shell only: `"allowed"` | `"blocked"` | `"blocked-review-pending"`.
    outcome: Option<String>,
    /// SQL only: whether the statement executed successfully.
    success: Option<bool>,
    /// SQL only: error text when the statement failed.
    error: Option<String>,
}

#[derive(Object)]
pub struct CommandRecordsResponse {
    items: Vec<CommandRecord>,
    /// Total number of records matching the filters (before pagination).
    total: u64,
    offset: u64,
    limit: u64,
}

#[derive(ApiResponse)]
enum ListResponse {
    #[oai(status = 200)]
    Ok(Json<CommandRecordsResponse>),
    #[oai(status = 400)]
    BadRequest(Json<String>),
}

pub struct Api;

#[OpenApi]
impl Api {
    /// List/search command records across the shell and SQL audit streams.
    ///
    /// Filters (all optional, AND-combined): `session_id`, `user_id`,
    /// `username`, `target_id`, `source` (`"shell"`|`"sql"`), `from`/`to`
    /// (RFC3339 timestamps), and `q` (case-insensitive substring over the
    /// command/query text). Results are newest-first; `limit` (default 100) and
    /// `offset` (default 0) paginate.
    #[oai(
        path = "/command-records",
        method = "get",
        operation_id = "get_command_records"
    )]
    #[allow(clippy::too_many_arguments)]
    async fn api_list(
        &self,
        db: Data<&SharedDatabaseConnection>,
        recordings: Data<&Arc<Mutex<SessionRecordings>>>,
        session_id: Query<Option<Uuid>>,
        user_id: Query<Option<Uuid>>,
        username: Query<Option<String>>,
        target_id: Query<Option<Uuid>>,
        source: Query<Option<String>>,
        from: Query<Option<String>>,
        to: Query<Option<String>>,
        q: Query<Option<String>>,
        limit: Query<Option<u64>>,
        offset: Query<Option<u64>>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<ListResponse, GatedError> {
        // Resolve the `source` discriminator to the DB recording kinds to load.
        let kinds: Vec<RecordingKind> = match source.0.as_deref() {
            None | Some("") => vec![RecordingKind::CommandAudit, RecordingKind::SqlAudit],
            Some("shell") => vec![RecordingKind::CommandAudit],
            Some("sql") => vec![RecordingKind::SqlAudit],
            Some(other) => {
                return Ok(ListResponse::BadRequest(Json(format!(
                    "source must be one of \"shell\" | \"sql\" (got {other:?})"
                ))));
            }
        };

        // Parse the optional RFC3339 time bounds up front so a malformed value
        // is a 400 rather than a silently-ignored filter.
        let from_ts = match parse_ts(from.0.as_deref()) {
            Ok(v) => v,
            Err(e) => {
                return Ok(ListResponse::BadRequest(Json(format!(
                    "invalid `from`: {e}"
                ))))
            }
        };
        let to_ts = match parse_ts(to.0.as_deref()) {
            Ok(v) => v,
            Err(e) => return Ok(ListResponse::BadRequest(Json(format!("invalid `to`: {e}")))),
        };

        let db = gated_core::db_required(&db).await?;

        // Candidate recordings: the requested kinds, optionally one session.
        let mut query = Recording::Entity::find()
            .filter(Recording::Column::Kind.is_in(kinds))
            .order_by_desc(Recording::Column::Started);
        if let Some(sid) = session_id.0 {
            query = query.filter(Recording::Column::SessionId.eq(sid));
        }
        let recs = query.all(&db).await?;

        // Load the parent sessions once so SQL items (which carry no user in the
        // item itself) can inherit the session username.
        let session_ids: Vec<Uuid> = {
            let mut ids: Vec<Uuid> = recs.iter().map(|r| r.session_id).collect();
            ids.sort();
            ids.dedup();
            ids
        };
        let sessions: HashMap<Uuid, Session::Model> = if session_ids.is_empty() {
            HashMap::new()
        } else {
            Session::Entity::find()
                .filter(Session::Column::Id.is_in(session_ids))
                .all(&db)
                .await?
                .into_iter()
                .map(|s| (s.id, s))
                .collect()
        };

        // Snapshot every recording's on-disk path under one lock, then read the
        // files without holding the recordings mutex.
        let paths: Vec<(Recording::Model, std::path::PathBuf)> = {
            let store = recordings.lock().await;
            recs.into_iter()
                .map(|r| {
                    let path = store.path_for(&r.session_id, &r.name);
                    (r, path)
                })
                .collect()
        };

        let mut records: Vec<CommandRecord> = Vec::new();
        for (rec, path) in paths {
            let session_username = sessions
                .get(&rec.session_id)
                .and_then(|s| s.username.clone());
            if let Err(error) =
                read_recording_into(&path, &rec, session_username.as_deref(), &mut records).await
            {
                // A recording row whose file is missing/unreadable must not sink
                // the whole query; skip it and keep merging the rest.
                warn!(%error, recording = %rec.id, path = ?path, "skipping unreadable command recording");
            }
        }

        // Apply the in-memory filters that can't be pushed into the DB query
        // (they live inside the recording items, not on the Recording row).
        let username_needle = username.0.as_deref().map(str::to_ascii_lowercase);
        let q_needle = q.0.as_deref().map(str::to_ascii_lowercase);
        records.retain(|r| {
            if let Some(uid) = user_id.0 {
                if r.user_id != Some(uid) {
                    return false;
                }
            }
            if let Some(ref needle) = username_needle {
                match &r.username {
                    Some(u) if u.to_ascii_lowercase() == *needle => {}
                    _ => return false,
                }
            }
            if let Some(tid) = target_id.0 {
                if r.target_id != Some(tid) {
                    return false;
                }
            }
            if let Some(from) = from_ts {
                if r.timestamp < from {
                    return false;
                }
            }
            if let Some(to) = to_ts {
                if r.timestamp > to {
                    return false;
                }
            }
            if let Some(ref needle) = q_needle {
                if !r.command.to_ascii_lowercase().contains(needle) {
                    return false;
                }
            }
            true
        });

        // Newest first, then paginate over the merged set.
        records.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
        let total = records.len() as u64;
        let offset = offset.0.unwrap_or(0);
        let limit = limit.0.unwrap_or(100);
        let items: Vec<CommandRecord> = records
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();

        Ok(ListResponse::Ok(Json(CommandRecordsResponse {
            items,
            total,
            offset,
            limit,
        })))
    }
}

/// Parse an optional RFC3339 timestamp query value into UTC.
fn parse_ts(value: Option<&str>) -> Result<Option<DateTime<Utc>>, chrono::ParseError> {
    match value {
        None | Some("") => Ok(None),
        Some(s) => Ok(Some(DateTime::parse_from_rfc3339(s)?.with_timezone(&Utc))),
    }
}

/// Read one structured recording file (JSONL) and append its items to `out`,
/// mapping each into the unified [`CommandRecord`] shape according to the
/// recording kind. Malformed individual lines are skipped so a single corrupt
/// entry doesn't drop the rest of the stream.
async fn read_recording_into(
    path: &std::path::Path,
    rec: &Recording::Model,
    session_username: Option<&str>,
    out: &mut Vec<CommandRecord>,
) -> anyhow::Result<()> {
    let file = tokio::fs::File::open(path).await?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        match rec.kind {
            RecordingKind::CommandAudit => {
                match serde_json::from_str::<ShellCommandRecordingItem>(&line) {
                    Ok(ShellCommandRecordingItem::Command {
                        timestamp,
                        target,
                        target_id,
                        user_id,
                        username,
                        origin,
                        command,
                        acl_action,
                        acl_rule_id,
                        acl_rule_name,
                        outcome,
                    }) => out.push(CommandRecord {
                        source: "shell".to_string(),
                        timestamp,
                        session_id: rec.session_id,
                        target: Some(target),
                        target_id,
                        user_id,
                        username,
                        command,
                        origin: Some(origin),
                        acl_action: Some(acl_action),
                        acl_rule_id,
                        acl_rule_name,
                        outcome: Some(outcome),
                        success: None,
                        error: None,
                    }),
                    Err(error) => {
                        warn!(%error, recording = %rec.id, "skipping malformed shell-command item");
                    }
                }
            }
            RecordingKind::SqlAudit => match serde_json::from_str::<SqlAuditRecordingItem>(&line) {
                Ok(SqlAuditRecordingItem::Query {
                    timestamp,
                    target,
                    sql,
                    success,
                    error,
                    ..
                }) => out.push(CommandRecord {
                    source: "sql".to_string(),
                    timestamp,
                    session_id: rec.session_id,
                    target: Some(target),
                    target_id: None,
                    user_id: None,
                    username: session_username.map(str::to_string),
                    command: sql,
                    origin: None,
                    acl_action: None,
                    acl_rule_id: None,
                    acl_rule_name: None,
                    outcome: None,
                    success: Some(success),
                    error,
                }),
                Err(error) => {
                    warn!(%error, recording = %rec.id, "skipping malformed sql-audit item");
                }
            },
            // Only the two structured command kinds are queried here; the DB
            // filter already excludes everything else, so this is unreachable in
            // practice but keeps the match exhaustive.
            _ => {}
        }
    }
    Ok(())
}
