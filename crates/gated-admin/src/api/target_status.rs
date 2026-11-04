use chrono::{DateTime, Utc};
use gated_common::web::{Data, Json};
use gated_common::{GatedError, api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::{Target, TargetStatus};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

/// Most targets one check request may name.
const MAX_CHECK_TARGETS: usize = 200;

/// The last reachability check of a target.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TargetStatusInfo {
    pub target_id: Uuid,
    pub reachable: bool,
    pub latency_ms: Option<i32>,
    pub error: Option<String>,
    pub checked_at: DateTime<Utc>,
}

impl From<TargetStatus::Model> for TargetStatusInfo {
    fn from(model: TargetStatus::Model) -> Self {
        Self {
            target_id: model.target_id,
            reachable: model.reachable,
            latency_ms: model.latency_ms,
            error: model.error,
            checked_at: model.checked_at,
        }
    }
}

api_response! {
    enum GetTargetStatusesResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<TargetStatusInfo>>),
    }
}

/// The last check of every target that has been checked.
#[utoipa::path(get, path = "/targets/status", operation_id = "get_target_statuses")]
async fn api_get_target_statuses(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetTargetStatusesResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let statuses = TargetStatus::Entity::find().all(&db).await?;
    Ok(GetTargetStatusesResponse::Ok(Json(
        statuses.into_iter().map(Into::into).collect(),
    )))
}

#[derive(Deserialize, ToSchema)]
struct CheckTargetsRequest {
    target_ids: Vec<Uuid>,
}

api_response! {
    enum CheckTargetsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<TargetStatusInfo>>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

/// Opens a TCP connection to each target's service port (3 s timeout, 16 at
/// once), stores and returns the results. Unknown ids are skipped.
#[utoipa::path(post, path = "/targets/check", operation_id = "check_targets")]
async fn api_check_targets(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    Json(body): Json<CheckTargetsRequest>,
) -> Result<CheckTargetsResponse, GatedError> {
    if body.target_ids.is_empty() || body.target_ids.len() > MAX_CHECK_TARGETS {
        return Ok(CheckTargetsResponse::BadRequest(Json(format!(
            "target_ids must name 1 to {MAX_CHECK_TARGETS} targets"
        ))));
    }
    let db = gated_core::db_required(&db).await?;
    let targets = Target::Entity::find()
        .filter(Target::Column::Id.is_in(body.target_ids))
        .all(&db)
        .await?;
    let results = gated_core::target_status::check_targets(&db, &targets).await?;
    Ok(CheckTargetsResponse::Ok(Json(
        results.into_iter().map(Into::into).collect(),
    )))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_target_statuses, api_check_targets)
}
