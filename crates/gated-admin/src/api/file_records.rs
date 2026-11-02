//! Admin API to query file operations recorded by `FileAuditRecorder`
//! (native SFTP and the web file manager). Read-only and admin-gated like
//! `command_records`.

use std::sync::Arc;

use axum::extract::Query;
use chrono::{DateTime, Utc};
use gated_common::web::{Data, Json};
use gated_common::{GatedError, api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_core::recordings::{FileAuditRecordingItem, SessionRecordings};
use gated_db_entities::Recording::{self, RecordingKind};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::*;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
pub struct FileRecord {
    timestamp: DateTime<Utc>,
    session_id: Uuid,
    target: String,
    target_id: Option<Uuid>,
    user_id: Option<Uuid>,
    username: Option<String>,
    /// `"sftp"` | `"web"`.
    origin: String,
    /// `"read"` | `"write"` | `"remove"` | `"rename"` | `"mkdir"` | `"rmdir"` | `"symlink"` | `"setstat"`.
    operation: String,
    path: String,
    new_path: Option<String>,
    bytes: Option<u64>,
    success: bool,
    error: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct FileRecordsResponse {
    items: Vec<FileRecord>,
    /// Total number of records matching the filters (before pagination).
    total: u64,
    offset: u64,
    limit: u64,
}

api_response! {
    enum ListResponse {
        #[oai(status = 200)]
        Ok(Json<FileRecordsResponse>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

#[derive(Deserialize, IntoParams, Default)]
#[into_params(parameter_in = Query)]
struct ListQuery {
    session_id: Option<Uuid>,
    username: Option<String>,
    target_id: Option<Uuid>,
    /// `"sftp"` | `"web"`.
    origin: Option<String>,
    operation: Option<String>,
    from: Option<String>,
    to: Option<String>,
    /// Case-insensitive substring over `path` and `new_path`.
    q: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
}

/// List/search file operations, newest first. Filters are AND-combined;
/// `limit` defaults to 100.
#[utoipa::path(
    get,
    path = "/file-records",
    operation_id = "get_file_records",
    params(ListQuery)
)]
async fn api_list(
    db: Data<SharedDatabaseConnection>,
    recordings: Data<Arc<Mutex<SessionRecordings>>>,
    _sec_scheme: AnySecurityScheme,
    Query(query): Query<ListQuery>,
) -> Result<ListResponse, GatedError> {
    let from = match parse_ts(query.from.as_deref()) {
        Ok(v) => v,
        Err(e) => {
            return Ok(ListResponse::BadRequest(Json(format!(
                "invalid `from`: {e}"
            ))));
        }
    };
    let to = match parse_ts(query.to.as_deref()) {
        Ok(v) => v,
        Err(e) => return Ok(ListResponse::BadRequest(Json(format!("invalid `to`: {e}")))),
    };

    let db = gated_core::db_required(&db).await?;
    let mut recs = Recording::Entity::find()
        .filter(Recording::Column::Kind.eq(RecordingKind::FileAudit))
        .order_by_desc(Recording::Column::Started);
    if let Some(sid) = query.session_id {
        recs = recs.filter(Recording::Column::SessionId.eq(sid));
    }
    let recs = recs.all(&db).await?;

    let paths: Vec<_> = {
        let store = recordings.lock().await;
        recs.into_iter()
            .map(|r| {
                let path = store.path_for(&r.session_id, &r.name);
                (r, path)
            })
            .collect()
    };

    let mut records = Vec::new();
    for (rec, path) in paths {
        match tokio::fs::read_to_string(&path).await {
            Ok(content) => records.extend(parse_items(&content, rec.session_id)),
            Err(error) => {
                warn!(%error, recording = %rec.id, path = ?path, "skipping unreadable file recording");
            }
        }
    }

    let records = apply_filters(records, &query, from, to);
    let total = records.len() as u64;
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(100);
    let items = records
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();

    Ok(ListResponse::Ok(Json(FileRecordsResponse {
        items,
        total,
        offset,
        limit,
    })))
}

fn parse_ts(value: Option<&str>) -> Result<Option<DateTime<Utc>>, chrono::ParseError> {
    match value {
        None | Some("") => Ok(None),
        Some(s) => Ok(Some(DateTime::parse_from_rfc3339(s)?.with_timezone(&Utc))),
    }
}

/// Parse a JSONL file audit stream, skipping malformed lines.
fn parse_items(content: &str, session_id: Uuid) -> Vec<FileRecord> {
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(
            |line| match serde_json::from_str::<FileAuditRecordingItem>(line) {
                Ok(FileAuditRecordingItem::Operation {
                    timestamp,
                    target,
                    target_id,
                    user_id,
                    username,
                    origin,
                    operation,
                    path,
                    new_path,
                    bytes,
                    success,
                    error,
                }) => Some(FileRecord {
                    timestamp,
                    session_id,
                    target,
                    target_id,
                    user_id,
                    username,
                    origin,
                    operation,
                    path,
                    new_path,
                    bytes,
                    success,
                    error,
                }),
                Err(error) => {
                    warn!(%error, session = %session_id, "skipping malformed file audit item");
                    None
                }
            },
        )
        .collect()
}

/// Apply the item-level filters and sort newest first.
fn apply_filters(
    mut records: Vec<FileRecord>,
    query: &ListQuery,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Vec<FileRecord> {
    let username = query.username.as_deref().map(str::to_ascii_lowercase);
    let q = query.q.as_deref().map(str::to_ascii_lowercase);
    records.retain(|r| {
        username
            .as_ref()
            .is_none_or(|u| r.username.as_deref().map(str::to_ascii_lowercase).as_ref() == Some(u))
            && query.target_id.is_none_or(|t| r.target_id == Some(t))
            && query
                .origin
                .as_deref()
                .is_none_or(|o| o.is_empty() || r.origin == o)
            && query
                .operation
                .as_deref()
                .is_none_or(|o| o.is_empty() || r.operation == o)
            && from.is_none_or(|f| r.timestamp >= f)
            && to.is_none_or(|t| r.timestamp <= t)
            && q.as_ref().is_none_or(|q| {
                r.path.to_ascii_lowercase().contains(q)
                    || r.new_path
                        .as_deref()
                        .is_some_and(|p| p.to_ascii_lowercase().contains(q))
            })
    });
    records.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    records
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_list,)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(ts: &str, user: &str, origin: &str, operation: &str, path: &str) -> String {
        serde_json::json!({
            "type": "file-operation",
            "timestamp": ts,
            "target": "web",
            "target_id": null,
            "user_id": null,
            "username": user,
            "origin": origin,
            "operation": operation,
            "path": path,
            "new_path": null,
            "bytes": 10,
            "success": true,
            "error": null,
        })
        .to_string()
    }

    fn sample() -> Vec<FileRecord> {
        let content = [
            line(
                "2026-10-21T01:00:00Z",
                "alice",
                "sftp",
                "read",
                "/etc/hosts",
            ),
            "not json".to_string(),
            line(
                "2026-10-21T02:00:00Z",
                "Bob",
                "web",
                "write",
                "/tmp/Upload.bin",
            ),
            line("2026-10-21T03:00:00Z", "alice", "web", "remove", "/tmp/old"),
        ]
        .join("\n");
        parse_items(&content, Uuid::nil())
    }

    #[test]
    fn parses_items_and_skips_malformed_lines() {
        let records = sample();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].path, "/etc/hosts");
        assert_eq!(records[0].bytes, Some(10));
        assert_eq!(records[0].session_id, Uuid::nil());
    }

    #[test]
    fn filters_and_sorts_newest_first() {
        let all = apply_filters(sample(), &ListQuery::default(), None, None);
        let paths: Vec<_> = all.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["/tmp/old", "/tmp/Upload.bin", "/etc/hosts"]);

        let query = ListQuery {
            username: Some("bob".into()),
            q: Some("upload".into()),
            ..Default::default()
        };
        let only_bob = apply_filters(sample(), &query, None, None);
        assert_eq!(only_bob.len(), 1);

        let query = ListQuery {
            origin: Some("web".into()),
            operation: Some("remove".into()),
            ..Default::default()
        };
        assert_eq!(apply_filters(sample(), &query, None, None).len(), 1);

        let from = parse_ts(Some("2026-10-21T02:30:00Z")).unwrap();
        assert_eq!(
            apply_filters(sample(), &ListQuery::default(), from, None).len(),
            1
        );
    }
}
