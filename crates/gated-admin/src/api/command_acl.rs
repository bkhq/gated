//! Admin CRUD for command-ACL rules (`gated_core::command_acl`).
//!
//! Mounted under the `/admin/api` tree, which is wrapped in
//! `endpoint_auth(endpoint_admin_auth(..))` (see `http_service/mod.rs`), so
//! every route here is admin-gated. Rules are OFF by default: this API never
//! seeds any, an empty ruleset allows everything.

use axum::extract::Path;
use chrono::Utc;
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::CommandAclRule;
use regex::Regex;
use sea_orm::{ActiveModelTrait, EntityTrait, ModelTrait, QueryOrder, Set};
use serde::Deserialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

const PROTOCOLS: &[&str] = &["ssh", "mysql", "postgres", "any"];
const MATCH_TYPES: &[&str] = &["regex", "keyword"];
const ACTIONS: &[&str] = &["allow", "deny", "review"];

#[derive(Deserialize, ToSchema)]
struct CommandAclRuleRequest {
    name: String,
    /// Defaults to `true` when omitted.
    enabled: Option<bool>,
    /// Lower is evaluated first.
    priority: i32,
    /// "ssh" | "mysql" | "postgres" | "any".
    protocol: String,
    /// "regex" | "keyword".
    match_type: String,
    pattern: String,
    /// "allow" | "deny" | "review".
    action: String,
    /// Null = all targets.
    target_id: Option<Uuid>,
    /// Null = all roles.
    role_id: Option<Uuid>,
    description: Option<String>,
}

/// Validate the enum fields and (for regex rules) that the pattern compiles.
/// Returns a human-readable reason on the first problem.
fn validate(body: &CommandAclRuleRequest) -> Result<(), String> {
    if body.name.trim().is_empty() {
        return Err("name is required".into());
    }
    if body.pattern.trim().is_empty() {
        return Err("pattern is required".into());
    }
    if !PROTOCOLS.contains(&body.protocol.as_str()) {
        return Err(format!("protocol must be one of {PROTOCOLS:?}"));
    }
    if !MATCH_TYPES.contains(&body.match_type.as_str()) {
        return Err(format!("match_type must be one of {MATCH_TYPES:?}"));
    }
    if !ACTIONS.contains(&body.action.as_str()) {
        return Err(format!("action must be one of {ACTIONS:?}"));
    }
    if body.match_type == "regex"
        && let Err(e) = Regex::new(&body.pattern)
    {
        return Err(format!("invalid regex pattern: {e}"));
    }
    Ok(())
}

api_response! {
    enum ListResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<CommandAclRule::Model>>),
    }
}

api_response! {
    enum CreateResponse {
        #[oai(status = 201)]
        Created(Json<CommandAclRule::Model>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

#[utoipa::path(
    get,
    path = "/command-acl-rules",
    operation_id = "get_command_acl_rules"
)]
async fn api_list(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<ListResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let rules = CommandAclRule::Entity::find()
        .order_by_asc(CommandAclRule::Column::Priority)
        .order_by_asc(CommandAclRule::Column::Id)
        .all(&db)
        .await?;

    Ok(ListResponse::Ok(Json(rules)))
}

#[utoipa::path(
    post,
    path = "/command-acl-rules",
    operation_id = "create_command_acl_rule"
)]
async fn api_create(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<CommandAclRuleRequest>,
) -> Result<CreateResponse, GatedError> {
    if let Err(reason) = validate(&body) {
        return Ok(CreateResponse::BadRequest(Json(reason)));
    }

    let db = gated_core::db_required(&db).await?;
    let now = Utc::now();

    let model = CommandAclRule::ActiveModel {
        name: Set(body.name.trim().to_string()),
        enabled: Set(body.enabled.unwrap_or(true)),
        priority: Set(body.priority),
        protocol: Set(body.protocol.clone()),
        match_type: Set(body.match_type.clone()),
        pattern: Set(body.pattern.clone()),
        action: Set(body.action.clone()),
        target_id: Set(body.target_id),
        role_id: Set(body.role_id),
        description: Set(body.description.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&db)
    .await
    .map_err(GatedError::from)?;

    Ok(CreateResponse::Created(Json(model)))
}

api_response! {
    // The Ok payload is the full rule model; the NotFound variant is empty. The
    // size gap is inherent to an API-boundary response enum and boxing would
    // complicate the schema.
    #[allow(clippy::large_enum_variant)]
    enum GetResponse {
        #[oai(status = 200)]
        Ok(Json<CommandAclRule::Model>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum UpdateResponse {
        #[oai(status = 200)]
        Ok(Json<CommandAclRule::Model>),
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum DeleteResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(
    get,
    path = "/command-acl-rule/{id}",
    operation_id = "get_command_acl_rule"
)]
async fn api_get(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    Ok(
        match CommandAclRule::Entity::find_by_id(id.0).one(&db).await? {
            Some(model) => GetResponse::Ok(Json(model)),
            None => GetResponse::NotFound,
        },
    )
}

#[utoipa::path(
    put,
    path = "/command-acl-rule/{id}",
    operation_id = "update_command_acl_rule"
)]
async fn api_update(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<CommandAclRuleRequest>,
) -> Result<UpdateResponse, GatedError> {
    if let Err(reason) = validate(&body) {
        return Ok(UpdateResponse::BadRequest(Json(reason)));
    }

    let db = gated_core::db_required(&db).await?;

    let Some(existing) = CommandAclRule::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(UpdateResponse::NotFound);
    };

    let mut model: CommandAclRule::ActiveModel = existing.into();
    model.name = Set(body.name.trim().to_string());
    model.enabled = Set(body.enabled.unwrap_or(true));
    model.priority = Set(body.priority);
    model.protocol = Set(body.protocol.clone());
    model.match_type = Set(body.match_type.clone());
    model.pattern = Set(body.pattern.clone());
    model.action = Set(body.action.clone());
    model.target_id = Set(body.target_id);
    model.role_id = Set(body.role_id);
    model.description = Set(body.description.clone());
    model.updated_at = Set(Utc::now());

    let model = model.update(&db).await.map_err(GatedError::from)?;

    Ok(UpdateResponse::Ok(Json(model)))
}

#[utoipa::path(
    delete,
    path = "/command-acl-rule/{id}",
    operation_id = "delete_command_acl_rule"
)]
async fn api_delete(
    id: Path<i32>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(model) = CommandAclRule::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(DeleteResponse::NotFound);
    };

    model.delete(&db).await?;
    Ok(DeleteResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_list, api_create, api_get, api_update, api_delete,)
}
