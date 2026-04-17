use std::sync::Arc;

use chrono::{DateTime, Utc};
use poem::web::Data;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use tokio::sync::Mutex;
use uuid::Uuid;
use gated_common::GatedError;
use gated_db_entities::{LogEntry, Session};

use super::AnySecurityScheme;

pub struct Api;

#[derive(ApiResponse)]
enum GetLogsResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<LogEntry::Model>>),
}

#[derive(Object)]
struct GetLogsRequest {
    before: Option<DateTime<Utc>>,
    after: Option<DateTime<Utc>>,
    limit: Option<u64>,
    session_id: Option<Uuid>,
    username: Option<String>,
    search: Option<String>,
    target_name: Option<String>,
}

#[OpenApi]
impl Api {
    #[oai(path = "/logs", method = "post", operation_id = "get_logs")]
    async fn api_get_all_logs(
        &self,
        db: Data<&Arc<Mutex<DatabaseConnection>>>,
        body: Json<GetLogsRequest>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetLogsResponse, GatedError> {
        use gated_db_entities::LogEntry;

        let db = db.lock().await;
        let mut q = LogEntry::Entity::find()
            .order_by_desc(LogEntry::Column::Timestamp)
            .limit(body.limit.unwrap_or(100));

        if let Some(before) = body.before {
            q = q.filter(LogEntry::Column::Timestamp.lt(before));
        }
        if let Some(after) = body.after {
            q = q
                .filter(LogEntry::Column::Timestamp.gt(after))
                .order_by_asc(LogEntry::Column::Timestamp);
        }
        if let Some(ref session_id) = body.session_id {
            q = q.filter(LogEntry::Column::SessionId.eq(*session_id));
        }
        if let Some(ref username) = body.username {
            q = q.filter(LogEntry::Column::SessionId.eq(username.clone()));
        }
        if let Some(ref target_name) = body.target_name {
            // Find session IDs whose target_snapshot contains this target name
            let session_ids: Vec<Uuid> = Session::Entity::find()
                .filter(Session::Column::TargetSnapshot.contains(target_name))
                .all(&*db)
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
        if let Some(ref search) = body.search {
            q = q.filter(
                LogEntry::Column::Text
                    .contains(search)
                    .or(LogEntry::Column::Username.contains(search))
                    .or(LogEntry::Column::Values.contains(search)),
            );
        }

        let logs = q.all(&*db).await?;
        Ok(GetLogsResponse::Ok(Json(logs)))
    }
}
