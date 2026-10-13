//! Admin endpoints to LIST pending command reviews and APPROVE/REJECT one.
//!
//! Mounted under the `/admin/api` tree, which is wrapped in
//! `endpoint_auth(endpoint_admin_auth(..))` (see `http_service/mod.rs`), so
//! every route here is admin-gated. Mirrors the web-approval flow in
//! `http_service/api/auth.rs` but resolves entries in `command_review_store`
//! (not `auth_state_store`): approving/rejecting calls `complete()`, which
//! releases the paused SSH session. Feature is OFF by default — the list is
//! empty unless an `action=review` command-ACL rule matched.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use gated_core::{CommandReviewDecision, CommandReviewInfo, CommandReviewStore};
use poem::web::Data;
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::AnySecurityScheme;

/// One pending command review, for the admin list/decision UI.
#[derive(Object)]
struct CommandReviewItem {
    id: Uuid,
    session_id: Option<Uuid>,
    user_id: Option<Uuid>,
    username: Option<String>,
    target_id: Option<Uuid>,
    target_name: String,
    /// Always `"exec"` today (the guaranteed-flow path).
    origin: String,
    command: String,
    acl_rule_id: Option<i64>,
    acl_rule_name: Option<String>,
    requested_at: DateTime<Utc>,
}

impl From<CommandReviewInfo> for CommandReviewItem {
    fn from(info: CommandReviewInfo) -> Self {
        Self {
            id: info.id,
            session_id: info.session_id,
            user_id: info.user_id,
            username: info.username,
            target_id: info.target_id,
            target_name: info.target_name,
            origin: info.origin,
            command: info.command,
            acl_rule_id: info.acl_rule_id,
            acl_rule_name: info.acl_rule_name,
            requested_at: info.requested_at,
        }
    }
}

#[derive(ApiResponse)]
enum ListResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<CommandReviewItem>>),
}

#[derive(ApiResponse)]
enum DecisionResponse {
    /// The paused session was released with the given decision.
    #[oai(status = 200)]
    Ok,
    /// No pending review with this id (already decided, timed out, or unknown).
    #[oai(status = 404)]
    NotFound,
}

pub struct Api;

#[OpenApi]
impl Api {
    #[oai(
        path = "/command-reviews",
        method = "get",
        operation_id = "get_command_reviews"
    )]
    async fn api_list(
        &self,
        store: Data<&Arc<Mutex<CommandReviewStore>>>,
        _sec_scheme: AnySecurityScheme,
    ) -> ListResponse {
        let items = store
            .lock()
            .await
            .list()
            .into_iter()
            .map(CommandReviewItem::from)
            .collect();
        ListResponse::Ok(Json(items))
    }

    #[oai(
        path = "/command-review/:id/approve",
        method = "post",
        operation_id = "approve_command_review"
    )]
    async fn api_approve(
        &self,
        store: Data<&Arc<Mutex<CommandReviewStore>>>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> DecisionResponse {
        if store
            .lock()
            .await
            .complete(&id, CommandReviewDecision::Approved)
        {
            DecisionResponse::Ok
        } else {
            DecisionResponse::NotFound
        }
    }

    #[oai(
        path = "/command-review/:id/reject",
        method = "post",
        operation_id = "reject_command_review"
    )]
    async fn api_reject(
        &self,
        store: Data<&Arc<Mutex<CommandReviewStore>>>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> DecisionResponse {
        if store
            .lock()
            .await
            .complete(&id, CommandReviewDecision::Rejected)
        {
            DecisionResponse::Ok
        } else {
            DecisionResponse::NotFound
        }
    }
}
