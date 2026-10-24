use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::{LogEntry, ManagementAudit, Session};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Deserialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

api_response! {
    enum GetLogsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<LogEntry::Model>>),
    }
}

#[derive(Deserialize, ToSchema)]
struct GetLogsRequest {
    before: Option<DateTime<Utc>>,
    after: Option<DateTime<Utc>>,
    limit: Option<u64>,
    session_id: Option<Uuid>,
    username: Option<String>,
    search: Option<String>,
    target_name: Option<String>,
}

#[utoipa::path(post, path = "/logs", operation_id = "get_logs")]
async fn api_get_all_logs(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<GetLogsRequest>,
) -> Result<GetLogsResponse, GatedError> {
    use gated_db_entities::LogEntry;

    let db = gated_core::db_required(&db).await?;
    let mut q = apply_scalar_filters(LogEntry::Entity::find(), &body);

    if let Some(ref target_name) = body.target_name {
        // Find session IDs whose target_snapshot contains this target name
        let session_ids: Vec<Uuid> = Session::Entity::find()
            .filter(Session::Column::TargetSnapshot.contains(target_name))
            .all(&db)
            .await?
            .into_iter()
            .filter(|s| {
                // Parse the target_snapshot JSON to verify the exact name match
                s.target_snapshot
                    .as_deref()
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
                    .and_then(|v| v.get("name")?.as_str().map(|n| n == target_name))
                    .unwrap_or(false)
            })
            .map(|s| s.id)
            .collect();

        if session_ids.is_empty() {
            return Ok(GetLogsResponse::Ok(Json(vec![])));
        }

        q = q.filter(LogEntry::Column::SessionId.is_in(session_ids));
    }
    let logs = q.all(&db).await?;
    Ok(GetLogsResponse::Ok(Json(logs)))
}
#[utoipa::path(
    post,
    path = "/management-audit",
    operation_id = "get_management_audit"
)]
async fn api_get_management_audit(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<GetLogsRequest>,
) -> Result<GetLogsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    if body.target_name.is_some() {
        return Ok(GetLogsResponse::Ok(Json(vec![])));
    }
    let entries = apply_management_filters(ManagementAudit::Entity::find(), &body)
        .all(&db)
        .await?;
    Ok(GetLogsResponse::Ok(Json(
        entries
            .into_iter()
            .map(|entry| LogEntry::Model {
                id: entry.id,
                text: entry.text,
                values: entry.values,
                timestamp: entry.timestamp,
                session_id: entry.session_id,
                username: entry.username,
            })
            .collect(),
    )))
}

/// Apply the filters that do not need a database round-trip. `after` flips
/// the ordering to ascending so a "load newer entries" poll gets them in
/// chronological order; every other query is newest-first.
fn apply_scalar_filters(
    q: sea_orm::Select<LogEntry::Entity>,
    body: &GetLogsRequest,
) -> sea_orm::Select<LogEntry::Entity> {
    let mut q = q.limit(body.limit.unwrap_or(100));

    if let Some(after) = body.after {
        q = q
            .filter(LogEntry::Column::Timestamp.gt(after))
            .order_by_asc(LogEntry::Column::Timestamp);
    } else {
        q = q.order_by_desc(LogEntry::Column::Timestamp);
    }
    if let Some(before) = body.before {
        q = q.filter(LogEntry::Column::Timestamp.lt(before));
    }
    if let Some(ref session_id) = body.session_id {
        q = q.filter(LogEntry::Column::SessionId.eq(*session_id));
    }
    if let Some(ref username) = body.username {
        q = q.filter(LogEntry::Column::Username.eq(username.clone()));
    }
    if let Some(ref search) = body.search {
        q = q.filter(
            LogEntry::Column::Text
                .contains(search)
                .or(LogEntry::Column::Username.contains(search))
                .or(LogEntry::Column::Values.contains(search)),
        );
    }
    q
}

fn apply_management_filters(
    q: sea_orm::Select<ManagementAudit::Entity>,
    body: &GetLogsRequest,
) -> sea_orm::Select<ManagementAudit::Entity> {
    let mut q = q.limit(body.limit.unwrap_or(100));

    if let Some(after) = body.after {
        q = q
            .filter(ManagementAudit::Column::Timestamp.gt(after))
            .order_by_asc(ManagementAudit::Column::Timestamp);
    } else {
        q = q.order_by_desc(ManagementAudit::Column::Timestamp);
    }
    if let Some(before) = body.before {
        q = q.filter(ManagementAudit::Column::Timestamp.lt(before));
    }
    if let Some(ref session_id) = body.session_id {
        q = q.filter(ManagementAudit::Column::SessionId.eq(*session_id));
    }
    if let Some(ref username) = body.username {
        q = q.filter(ManagementAudit::Column::Username.eq(username.clone()));
    }
    if let Some(ref search) = body.search {
        q = q.filter(
            ManagementAudit::Column::Text
                .contains(search)
                .or(ManagementAudit::Column::Username.contains(search))
                .or(ManagementAudit::Column::Values.contains(search)),
        );
    }
    q
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all_logs, api_get_management_audit,)
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use sea_orm::{
        ActiveModelTrait, ConnectionTrait, Database, DatabaseConnection, DbBackend, Set, Statement,
    };

    use super::*;

    async fn setup_log_db() -> DatabaseConnection {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            r#"CREATE TABLE log (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                "values" TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                session_id TEXT NOT NULL,
                username TEXT
            )"#,
        ))
        .await
        .expect("create log table");
        conn
    }

    async fn insert(db: &DatabaseConnection, username: &str, text: &str, age_secs: i64) {
        LogEntry::ActiveModel {
            id: Set(Uuid::new_v4()),
            text: Set(text.into()),
            values: Set(serde_json::json!({})),
            timestamp: Set(Utc::now() - Duration::seconds(age_secs)),
            session_id: Set(Uuid::new_v4()),
            username: Set(Some(username.into())),
        }
        .insert(db)
        .await
        .expect("insert log");
    }

    fn request() -> GetLogsRequest {
        GetLogsRequest {
            before: None,
            after: None,
            limit: None,
            session_id: None,
            username: None,
            search: None,
            target_name: None,
        }
    }

    #[tokio::test]
    async fn username_filter_matches_the_username_column() {
        let db = setup_log_db().await;
        insert(&db, "alice", "alice did a thing", 10).await;
        insert(&db, "bob", "bob did a thing", 5).await;

        let body = GetLogsRequest {
            username: Some("alice".into()),
            ..request()
        };
        let rows = apply_scalar_filters(LogEntry::Entity::find(), &body)
            .all(&db)
            .await
            .expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].username.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn after_returns_entries_oldest_first() {
        let db = setup_log_db().await;
        insert(&db, "alice", "older", 20).await;
        insert(&db, "alice", "newer", 5).await;

        let body = GetLogsRequest {
            after: Some(Utc::now() - Duration::seconds(60)),
            ..request()
        };
        let rows = apply_scalar_filters(LogEntry::Entity::find(), &body)
            .all(&db)
            .await
            .expect("query");
        let texts: Vec<&str> = rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, vec!["older", "newer"]);

        let rows = apply_scalar_filters(LogEntry::Entity::find(), &request())
            .all(&db)
            .await
            .expect("query");
        let texts: Vec<&str> = rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, vec!["newer", "older"]);
    }
}
