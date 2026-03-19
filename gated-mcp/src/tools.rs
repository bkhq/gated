use std::sync::Arc;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Set,
};
use chrono::{Duration, Utc};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;
use gated_common::helpers::hash::generate_ticket_secret;
use gated_core::consts::BUILTIN_ADMIN_ROLE_NAME;
use gated_core::{ConfigProvider, ConfigProviderEnum, Services, State};
use gated_db_entities::{
    Role, Session, Target, TargetRoleAssignment, Ticket, User, UserRoleAssignment,
};

use crate::auth::AuthContext;
use crate::protocol::JsonRpcError;

pub struct ToolHandler {
    db: Arc<Mutex<sea_orm::DatabaseConnection>>,
    config_provider: Arc<Mutex<ConfigProviderEnum>>,
    state: Arc<Mutex<State>>,
}

impl ToolHandler {
    pub fn new(services: &Services) -> Self {
        Self {
            db: services.db.clone(),
            config_provider: services.config_provider.clone(),
            state: services.state.clone(),
        }
    }

    pub async fn call(
        &self,
        tool_name: &str,
        args: Value,
        auth: &AuthContext,
    ) -> Result<Value, JsonRpcError> {
        // Tools available to all authenticated users (with per-user scoping)
        match tool_name {
            "list_targets" => return self.list_targets(args, auth).await,
            "list_sessions" => return self.list_sessions(args, auth).await,
            "get_session" => return self.get_session(args, auth).await,
            _ => {}
        }

        // All other tools require admin
        require_admin(auth)?;

        match tool_name {
            // ---- targets ----
            "get_target" => self.get_target(args).await,
            "create_target" => self.create_target(args).await,
            "update_target" => self.update_target(args).await,
            "delete_target" => self.delete_target(args).await,
            // ---- sessions ----
            "close_session" => self.close_session(args).await,
            // ---- users ----
            "list_users" => self.list_users(args).await,
            "get_user" => self.get_user(args).await,
            "create_user" => self.create_user(args).await,
            "update_user" => self.update_user(args).await,
            "delete_user" => self.delete_user(args).await,
            // ---- roles ----
            "list_roles" => self.list_roles(args).await,
            "create_role" => self.create_role(args).await,
            "update_role" => self.update_role(args).await,
            "delete_role" => self.delete_role(args).await,
            // ---- tickets ----
            "list_tickets" => self.list_tickets(args).await,
            "create_ticket" => self.create_ticket(args).await,
            "delete_ticket" => self.delete_ticket(args).await,
            // ---- role assignments ----
            "add_target_role" => self.add_target_role(args).await,
            "delete_target_role" => self.delete_target_role(args).await,
            "add_user_role" => self.add_user_role(args).await,
            "delete_user_role" => self.delete_user_role(args).await,
            _ => Err(JsonRpcError {
                code: -32602,
                message: format!("Unknown tool: {tool_name}"),
                data: None,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

impl ToolHandler {
    async fn list_targets(
        &self,
        args: Value,
        auth: &AuthContext,
    ) -> Result<Value, JsonRpcError> {
        let db = self.db.lock().await;
        let mut query = Target::Entity::find()
            .order_by_asc(Target::Column::Name)
            .limit(MAX_QUERY_LIMIT);

        if let Some(search) = args.get("search").and_then(|v| v.as_str()) {
            query = query.filter(Target::Column::Name.like(format!("%{}%", sanitize_like(search))));
        }
        if let Some(kind) = args.get("kind").and_then(|v| v.as_str()) {
            query = query.filter(Target::Column::Kind.eq(kind));
        }

        let targets = query.all(&*db).await.map_err(db_err)?;
        drop(db);

        let mut results = Vec::new();
        if auth.is_admin() {
            for t in targets {
                results.push(target_json(&t));
            }
        } else if let Some(username) = auth.username() {
            let mut cp = self.config_provider.lock().await;
            for t in targets {
                if cp.authorize_target(username, &t.name).await.unwrap_or(false) {
                    results.push(target_json(&t));
                }
            }
        }
        text_result(&results)
    }

    async fn get_target(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let target = Target::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        let roles: Vec<Value> = target
            .find_related(Role::Entity)
            .all(&*db)
            .await
            .map_err(db_err)?
            .into_iter()
            .map(|r| role_json(&r))
            .collect();

        let mut j = target_json(&target);
        j.as_object_mut().unwrap().insert("roles".into(), roles.into());
        text_result(&j)
    }

    async fn create_target(&self, args: Value) -> Result<Value, JsonRpcError> {
        let name = require_str(&args, "name")?;
        let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let options = args.get("options").ok_or_else(|| missing("options"))?;
        let kind = options
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| missing("options.kind"))?;

        if kind == "web_admin" {
            return Err(JsonRpcError {
                code: -32602,
                message: "Cannot create web_admin targets".into(),
                data: None,
            });
        }

        let db = self.db.lock().await;

        let existing = Target::Entity::find()
            .filter(Target::Column::Name.eq(name))
            .one(&*db)
            .await
            .map_err(db_err)?;
        if existing.is_some() {
            return Err(JsonRpcError {
                code: -32602,
                message: "Target name already exists".into(),
                data: None,
            });
        }

        let values = Target::ActiveModel {
            id: Set(Uuid::new_v4()),
            name: Set(name.to_string()),
            description: Set(description.to_string()),
            kind: Set(kind_from_str(kind)?),
            options: Set(options.clone()),
            rate_limit_bytes_per_second: Set(None),
            group_id: Set(None),
        };
        let target = values.insert(&*db).await.map_err(db_err)?;
        text_result(&target_json(&target))
    }

    async fn update_target(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let target = Target::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        let mut model: Target::ActiveModel = target.into();

        if let Some(name) = args.get("name").and_then(|v| v.as_str()) {
            model.name = Set(name.to_string());
        }
        if let Some(desc) = args.get("description").and_then(|v| v.as_str()) {
            model.description = Set(desc.to_string());
        }
        if let Some(opts) = args.get("options") {
            model.options = Set(opts.clone());
        }

        let target = model.update(&*db).await.map_err(db_err)?;
        text_result(&target_json(&target))
    }

    async fn delete_target(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let target = Target::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        if target.kind == Target::TargetKind::WebAdmin {
            return Err(JsonRpcError {
                code: -32602,
                message: "Cannot delete web_admin target".into(),
                data: None,
            });
        }

        TargetRoleAssignment::Entity::delete_many()
            .filter(TargetRoleAssignment::Column::TargetId.eq(id))
            .exec(&*db)
            .await
            .map_err(db_err)?;

        target.delete(&*db).await.map_err(db_err)?;
        ok_result("Target deleted")
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

impl ToolHandler {
    async fn list_sessions(
        &self,
        args: Value,
        auth: &AuthContext,
    ) -> Result<Value, JsonRpcError> {
        let db = self.db.lock().await;
        let mut query = Session::Entity::find().order_by_desc(Session::Column::Started);

        if args.get("active_only").and_then(|v| v.as_bool()).unwrap_or(false) {
            query = query.filter(Session::Column::Ended.is_null());
        }
        if args.get("logged_in_only").and_then(|v| v.as_bool()).unwrap_or(false) {
            query = query.filter(Session::Column::Username.is_not_null());
        }
        if let Some(username) = auth.username() {
            query = query.filter(Session::Column::Username.eq(username));
        }

        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(50)
            .min(MAX_QUERY_LIMIT);

        let total = query.clone().count(&*db).await.map_err(db_err)?;
        let sessions: Vec<Value> = query
            .limit(limit)
            .all(&*db)
            .await
            .map_err(db_err)?
            .into_iter()
            .map(|s| session_json(&s))
            .collect();

        text_result(&serde_json::json!({ "total": total, "items": sessions }))
    }

    async fn get_session(&self, args: Value, auth: &AuthContext) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let session = Session::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        // Non-admin users can only view their own sessions
        if let Some(username) = auth.username() {
            if session.username.as_deref() != Some(username) {
                return Err(not_found());
            }
        }

        text_result(&session_json(&session))
    }

    async fn close_session(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let state = self.state.lock().await;
        let session = state.sessions.get(&id).ok_or_else(not_found)?;
        session.lock().await.handle.close();
        ok_result("Session closed")
    }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

impl ToolHandler {
    async fn list_users(&self, args: Value) -> Result<Value, JsonRpcError> {
        let db = self.db.lock().await;
        let mut query = User::Entity::find()
            .order_by_asc(User::Column::Username)
            .limit(MAX_QUERY_LIMIT);
        if let Some(search) = args.get("search").and_then(|v| v.as_str()) {
            query = query.filter(User::Column::Username.like(format!("%{}%", sanitize_like(search))));
        }
        let users: Vec<Value> = query
            .all(&*db)
            .await
            .map_err(db_err)?
            .into_iter()
            .map(|u| user_json(&u))
            .collect();
        text_result(&users)
    }

    async fn get_user(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let user = User::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        let roles: Vec<Value> = user
            .find_related(Role::Entity)
            .all(&*db)
            .await
            .map_err(db_err)?
            .into_iter()
            .map(|r| role_json(&r))
            .collect();

        let mut j = user_json(&user);
        j.as_object_mut().unwrap().insert("roles".into(), roles.into());
        text_result(&j)
    }

    async fn create_user(&self, args: Value) -> Result<Value, JsonRpcError> {
        let username = require_str(&args, "username")?;
        let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");

        let db = self.db.lock().await;
        let values = User::ActiveModel {
            id: Set(Uuid::new_v4()),
            username: Set(username.to_string()),
            description: Set(description.to_string()),
            credential_policy: Set(serde_json::json!({})),
            rate_limit_bytes_per_second: Set(None),
            ldap_server_id: Set(None),
            ldap_object_uuid: Set(None),
        };
        let user = values.insert(&*db).await.map_err(db_err)?;
        text_result(&user_json(&user))
    }

    async fn update_user(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let user = User::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        let mut model: User::ActiveModel = user.into();
        if let Some(name) = args.get("username").and_then(|v| v.as_str()) {
            model.username = Set(name.to_string());
        }
        if let Some(desc) = args.get("description").and_then(|v| v.as_str()) {
            model.description = Set(desc.to_string());
        }

        let user = model.update(&*db).await.map_err(db_err)?;
        text_result(&user_json(&user))
    }

    async fn delete_user(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let user = User::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        UserRoleAssignment::Entity::delete_many()
            .filter(UserRoleAssignment::Column::UserId.eq(id))
            .exec(&*db)
            .await
            .map_err(db_err)?;

        user.delete(&*db).await.map_err(db_err)?;
        ok_result("User deleted")
    }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

impl ToolHandler {
    async fn list_roles(&self, args: Value) -> Result<Value, JsonRpcError> {
        let db = self.db.lock().await;
        let mut query = Role::Entity::find()
            .order_by_asc(Role::Column::Name)
            .limit(MAX_QUERY_LIMIT);
        if let Some(search) = args.get("search").and_then(|v| v.as_str()) {
            query = query.filter(Role::Column::Name.like(format!("%{}%", sanitize_like(search))));
        }
        let roles: Vec<Value> = query
            .all(&*db)
            .await
            .map_err(db_err)?
            .into_iter()
            .map(|r| role_json(&r))
            .collect();
        text_result(&roles)
    }

    async fn create_role(&self, args: Value) -> Result<Value, JsonRpcError> {
        let name = require_str(&args, "name")?;
        let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");

        let db = self.db.lock().await;
        let values = Role::ActiveModel {
            id: Set(Uuid::new_v4()),
            name: Set(name.to_string()),
            description: Set(description.to_string()),
        };
        let role = values.insert(&*db).await.map_err(db_err)?;
        text_result(&role_json(&role))
    }

    async fn update_role(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let role = Role::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        if role.name == BUILTIN_ADMIN_ROLE_NAME {
            return Err(JsonRpcError {
                code: -32602,
                message: "Cannot modify built-in admin role".into(),
                data: None,
            });
        }

        let mut model: Role::ActiveModel = role.into();
        if let Some(name) = args.get("name").and_then(|v| v.as_str()) {
            model.name = Set(name.to_string());
        }
        if let Some(desc) = args.get("description").and_then(|v| v.as_str()) {
            model.description = Set(desc.to_string());
        }

        let role = model.update(&*db).await.map_err(db_err)?;
        text_result(&role_json(&role))
    }

    async fn delete_role(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let role = Role::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        if role.name == BUILTIN_ADMIN_ROLE_NAME {
            return Err(JsonRpcError {
                code: -32602,
                message: "Cannot delete built-in admin role".into(),
                data: None,
            });
        }

        TargetRoleAssignment::Entity::delete_many()
            .filter(TargetRoleAssignment::Column::RoleId.eq(id))
            .exec(&*db)
            .await
            .map_err(db_err)?;
        UserRoleAssignment::Entity::delete_many()
            .filter(UserRoleAssignment::Column::RoleId.eq(id))
            .exec(&*db)
            .await
            .map_err(db_err)?;

        role.delete(&*db).await.map_err(db_err)?;
        ok_result("Role deleted")
    }
}

// ---------------------------------------------------------------------------
// Role assignments
// ---------------------------------------------------------------------------

impl ToolHandler {
    async fn add_target_role(&self, args: Value) -> Result<Value, JsonRpcError> {
        let target_id = parse_uuid(&args, "target_id")?;
        let role_id = parse_uuid(&args, "role_id")?;
        let db = self.db.lock().await;

        let exists = TargetRoleAssignment::Entity::find()
            .filter(TargetRoleAssignment::Column::TargetId.eq(target_id))
            .filter(TargetRoleAssignment::Column::RoleId.eq(role_id))
            .one(&*db)
            .await
            .map_err(db_err)?;
        if exists.is_some() {
            return Err(JsonRpcError {
                code: -32602,
                message: "Role already assigned to target".into(),
                data: None,
            });
        }

        let values = TargetRoleAssignment::ActiveModel {
            target_id: Set(target_id),
            role_id: Set(role_id),
            ..Default::default()
        };
        values.insert(&*db).await.map_err(db_err)?;
        ok_result("Role assigned to target")
    }

    async fn delete_target_role(&self, args: Value) -> Result<Value, JsonRpcError> {
        let target_id = parse_uuid(&args, "target_id")?;
        let role_id = parse_uuid(&args, "role_id")?;
        let db = self.db.lock().await;

        let target = Target::Entity::find_by_id(target_id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;
        let role = Role::Entity::find_by_id(role_id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        if role.name == BUILTIN_ADMIN_ROLE_NAME
            && target.kind == Target::TargetKind::WebAdmin
        {
            return Err(JsonRpcError {
                code: -32602,
                message: "Cannot remove admin role from web_admin target".into(),
                data: None,
            });
        }

        let assignment = TargetRoleAssignment::Entity::find()
            .filter(TargetRoleAssignment::Column::TargetId.eq(target_id))
            .filter(TargetRoleAssignment::Column::RoleId.eq(role_id))
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        assignment.delete(&*db).await.map_err(db_err)?;
        ok_result("Role removed from target")
    }

    async fn add_user_role(&self, args: Value) -> Result<Value, JsonRpcError> {
        let user_id = parse_uuid(&args, "user_id")?;
        let role_id = parse_uuid(&args, "role_id")?;
        let db = self.db.lock().await;

        let exists = UserRoleAssignment::Entity::find()
            .filter(UserRoleAssignment::Column::UserId.eq(user_id))
            .filter(UserRoleAssignment::Column::RoleId.eq(role_id))
            .one(&*db)
            .await
            .map_err(db_err)?;
        if exists.is_some() {
            return Err(JsonRpcError {
                code: -32602,
                message: "Role already assigned to user".into(),
                data: None,
            });
        }

        let values = UserRoleAssignment::ActiveModel {
            user_id: Set(user_id),
            role_id: Set(role_id),
            ..Default::default()
        };
        values.insert(&*db).await.map_err(db_err)?;
        ok_result("Role assigned to user")
    }

    async fn delete_user_role(&self, args: Value) -> Result<Value, JsonRpcError> {
        let user_id = parse_uuid(&args, "user_id")?;
        let role_id = parse_uuid(&args, "role_id")?;
        let db = self.db.lock().await;

        // Prevent removing the last admin role assignment (lockout protection)
        let role = Role::Entity::find_by_id(role_id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;
        if role.name == BUILTIN_ADMIN_ROLE_NAME {
            let admin_count = UserRoleAssignment::Entity::find()
                .filter(UserRoleAssignment::Column::RoleId.eq(role_id))
                .count(&*db)
                .await
                .map_err(db_err)?;
            if admin_count <= 1 {
                return Err(JsonRpcError {
                    code: -32602,
                    message: "Cannot remove the last admin role assignment".into(),
                    data: None,
                });
            }
        }

        let assignment = UserRoleAssignment::Entity::find()
            .filter(UserRoleAssignment::Column::UserId.eq(user_id))
            .filter(UserRoleAssignment::Column::RoleId.eq(role_id))
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;

        assignment.delete(&*db).await.map_err(db_err)?;
        ok_result("Role removed from user")
    }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

impl ToolHandler {
    async fn list_tickets(&self, _args: Value) -> Result<Value, JsonRpcError> {
        let db = self.db.lock().await;
        let tickets: Vec<Value> = Ticket::Entity::find()
            .order_by_desc(Ticket::Column::Created)
            .limit(MAX_QUERY_LIMIT)
            .all(&*db)
            .await
            .map_err(db_err)?
            .into_iter()
            .map(|t| ticket_json(&t))
            .collect();
        text_result(&tickets)
    }

    async fn create_ticket(&self, args: Value) -> Result<Value, JsonRpcError> {
        let username = require_str(&args, "username")?;
        let target_name = require_str(&args, "target_name")?;
        let description = args
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let expiry_minutes = args
            .get("expiry_minutes")
            .and_then(|v| v.as_u64())
            .unwrap_or(60);
        let expiry = Utc::now() + Duration::minutes(expiry_minutes as i64);

        let number_of_uses = args
            .get("number_of_uses")
            .and_then(|v| v.as_i64())
            .map(|n| n as i16);

        let db = self.db.lock().await;

        // Verify target exists
        let _target = Target::Entity::find()
            .filter(Target::Column::Name.eq(target_name))
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(|| JsonRpcError {
                code: -32602,
                message: format!("Target not found: {target_name}"),
                data: None,
            })?;

        // Verify user exists
        User::Entity::find()
            .filter(User::Column::Username.eq(username))
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(|| JsonRpcError {
                code: -32602,
                message: format!("User not found: {username}"),
                data: None,
            })?;

        let secret = generate_ticket_secret();
        let values = Ticket::ActiveModel {
            id: Set(Uuid::new_v4()),
            secret: Set(secret.expose_secret().to_string()),
            username: Set(username.to_string()),
            target: Set(target_name.to_string()),
            created: Set(Utc::now()),
            expiry: Set(Some(expiry)),
            uses_left: Set(number_of_uses),
            description: Set(description.to_string()),
        };
        let ticket = values.insert(&*db).await.map_err(db_err)?;

        let mut j = ticket_json(&ticket);
        let obj = j.as_object_mut().unwrap();
        obj.insert("secret".into(), secret.expose_secret().to_string().into());

        // Build usage instructions based on target kind
        let usage = format!(
            "Use via gated CLI or pass as ticket parameter: {}",
            secret.expose_secret()
        );
        obj.insert("usage".into(), usage.into());

        text_result(&j)
    }

    async fn delete_ticket(&self, args: Value) -> Result<Value, JsonRpcError> {
        let id = parse_uuid(&args, "id")?;
        let db = self.db.lock().await;
        let ticket = Ticket::Entity::find_by_id(id)
            .one(&*db)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;
        ticket.delete(&*db).await.map_err(db_err)?;
        ok_result("Ticket deleted")
    }
}

// ---------------------------------------------------------------------------
// JSON serialization helpers
// ---------------------------------------------------------------------------

fn target_json(t: &Target::Model) -> Value {
    serde_json::json!({
        "id": t.id.to_string(),
        "name": t.name,
        "description": t.description,
        "kind": format!("{:?}", t.kind).to_lowercase(),
        "options": t.options,
    })
}

fn session_json(s: &Session::Model) -> Value {
    serde_json::json!({
        "id": s.id.to_string(),
        "username": s.username,
        "target": s.target_snapshot.as_deref()
            .and_then(|t| serde_json::from_str::<Value>(t).ok()),
        "protocol": s.protocol,
        "started": s.started.to_rfc3339(),
        "ended": s.ended.map(|e| e.to_rfc3339()),
        "remote_address": s.remote_address,
    })
}

fn ticket_json(t: &Ticket::Model) -> Value {
    serde_json::json!({
        "id": t.id.to_string(),
        "username": t.username,
        "target": t.target,
        "description": t.description,
        "uses_left": t.uses_left,
        "expiry": t.expiry.map(|e| e.to_rfc3339()),
        "created": t.created.to_rfc3339(),
    })
}

fn user_json(u: &User::Model) -> Value {
    serde_json::json!({
        "id": u.id.to_string(),
        "username": u.username,
        "description": u.description,
    })
}

fn role_json(r: &Role::Model) -> Value {
    serde_json::json!({
        "id": r.id.to_string(),
        "name": r.name,
        "description": r.description,
    })
}

// ---------------------------------------------------------------------------
// Error / parsing helpers
// ---------------------------------------------------------------------------

fn require_admin(auth: &AuthContext) -> Result<(), JsonRpcError> {
    if !auth.is_admin() {
        return Err(JsonRpcError {
            code: -32001,
            message: "Admin access required".into(),
            data: None,
        });
    }
    Ok(())
}

fn db_err(e: impl std::fmt::Display) -> JsonRpcError {
    error!(%e, "Database error");
    JsonRpcError {
        code: -32603,
        message: "Database error".into(),
        data: None,
    }
}

fn not_found() -> JsonRpcError {
    JsonRpcError {
        code: -32602,
        message: "Not found".into(),
        data: None,
    }
}

fn missing(field: &str) -> JsonRpcError {
    JsonRpcError {
        code: -32602,
        message: format!("Missing required field: {field}"),
        data: None,
    }
}

fn parse_uuid(args: &Value, field: &str) -> Result<Uuid, JsonRpcError> {
    let s = args
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| missing(field))?;
    Uuid::parse_str(s).map_err(|_| JsonRpcError {
        code: -32602,
        message: format!("Invalid UUID for field: {field}"),
        data: None,
    })
}

const MAX_QUERY_LIMIT: u64 = 500;
const MAX_STRING_LEN: usize = 256;

fn require_str<'a>(args: &'a Value, field: &str) -> Result<&'a str, JsonRpcError> {
    let s = args
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| missing(field))?;
    if s.is_empty() {
        return Err(JsonRpcError {
            code: -32602,
            message: format!("Field must not be empty: {field}"),
            data: None,
        });
    }
    if s.len() > MAX_STRING_LEN {
        return Err(JsonRpcError {
            code: -32602,
            message: format!("{field} exceeds maximum length of {MAX_STRING_LEN}"),
            data: None,
        });
    }
    Ok(s)
}

fn sanitize_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn kind_from_str(s: &str) -> Result<Target::TargetKind, JsonRpcError> {
    match s {
        "ssh" => Ok(Target::TargetKind::Ssh),
        "mysql" => Ok(Target::TargetKind::MySql),
        "postgres" => Ok(Target::TargetKind::Postgres),
        "kubernetes" => Ok(Target::TargetKind::Kubernetes),
        _ => Err(JsonRpcError {
            code: -32602,
            message: format!("Invalid target kind: {s}"),
            data: None,
        }),
    }
}

fn text_result(data: &impl serde::Serialize) -> Result<Value, JsonRpcError> {
    let text = serde_json::to_string_pretty(data).map_err(|e| JsonRpcError {
        code: -32603,
        message: format!("Serialization error: {e}"),
        data: None,
    })?;
    Ok(serde_json::json!({
        "content": [{
            "type": "text",
            "text": text
        }]
    }))
}

fn ok_result(msg: &str) -> Result<Value, JsonRpcError> {
    Ok(serde_json::json!({
        "content": [{
            "type": "text",
            "text": msg
        }]
    }))
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

pub fn tool_definitions() -> Vec<Value> {
    vec![
        // ---- targets ----
        tool_def(
            "list_targets",
            "List available targets (servers/services). Admin sees all; users see only authorized targets.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "search": { "type": "string", "description": "Filter by name (substring match)" },
                    "kind": {
                        "type": "string",
                        "description": "Filter by type",
                        "enum": ["ssh", "mysql", "postgres", "kubernetes", "api"]
                    }
                }
            }),
        ),
        tool_def(
            "get_target",
            "Get a target by ID, including its assigned roles.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Target UUID" } },
                "required": ["id"]
            }),
        ),
        tool_def(
            "create_target",
            "Create a new target. Options must include a 'kind' field (ssh/mysql/postgres/kubernetes/api) and protocol-specific settings.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Unique target name" },
                    "description": { "type": "string" },
                    "options": { "type": "object", "description": "Must include 'kind' and protocol-specific fields (e.g. host, port, username)" }
                },
                "required": ["name", "options"]
            }),
        ),
        tool_def(
            "update_target",
            "Update an existing target's name, description, or options.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Target UUID" },
                    "name": { "type": "string" },
                    "description": { "type": "string" },
                    "options": { "type": "object" }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "delete_target",
            "Delete a target by ID. Cannot delete web_admin targets.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Target UUID" } },
                "required": ["id"]
            }),
        ),
        // ---- sessions ----
        tool_def(
            "list_sessions",
            "List sessions. Admin sees all; users see only their own.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "active_only": { "type": "boolean", "description": "Only active (not ended) sessions" },
                    "logged_in_only": { "type": "boolean", "description": "Only authenticated sessions" },
                    "limit": { "type": "integer", "description": "Max results (default 50)", "default": 50 }
                }
            }),
        ),
        tool_def(
            "get_session",
            "Get session details by ID. Non-admin users can only view their own sessions.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Session UUID" } },
                "required": ["id"]
            }),
        ),
        tool_def(
            "close_session",
            "Close an active session by ID.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Session UUID" } },
                "required": ["id"]
            }),
        ),
        // ---- users ----
        tool_def(
            "list_users",
            "List all users, optionally filtered by username.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "search": { "type": "string", "description": "Filter by username (substring match)" }
                }
            }),
        ),
        tool_def(
            "get_user",
            "Get user details by ID, including assigned roles.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "User UUID" } },
                "required": ["id"]
            }),
        ),
        tool_def(
            "create_user",
            "Create a new user.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "username": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["username"]
            }),
        ),
        tool_def(
            "update_user",
            "Update an existing user's username or description.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "User UUID" },
                    "username": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "delete_user",
            "Delete a user by ID.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "User UUID" } },
                "required": ["id"]
            }),
        ),
        // ---- roles ----
        tool_def(
            "list_roles",
            "List all roles, optionally filtered by name.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "search": { "type": "string", "description": "Filter by name (substring match)" }
                }
            }),
        ),
        tool_def(
            "create_role",
            "Create a new role.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["name"]
            }),
        ),
        tool_def(
            "update_role",
            "Update a role's name or description. Cannot modify the built-in admin role.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Role UUID" },
                    "name": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "delete_role",
            "Delete a role by ID. Cannot delete the built-in admin role.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Role UUID" } },
                "required": ["id"]
            }),
        ),
        // ---- tickets ----
        tool_def(
            "list_tickets",
            "List all access tickets.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
        tool_def(
            "create_ticket",
            "Create a temporary access ticket for a user to access a specific target. Returns the ticket secret which can be used as: query param (?gated-ticket=SECRET) or header (Authorization: Gated SECRET). Tickets are time-limited and optionally use-limited. Admin only.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "username": { "type": "string", "description": "Username to grant access to" },
                    "target_name": { "type": "string", "description": "Target name (not UUID)" },
                    "expiry_minutes": { "type": "integer", "description": "Minutes until expiry (default 60)", "default": 60 },
                    "number_of_uses": { "type": "integer", "description": "Max number of uses (omit for unlimited)" },
                    "description": { "type": "string", "description": "Ticket description" }
                },
                "required": ["username", "target_name"]
            }),
        ),
        tool_def(
            "delete_ticket",
            "Revoke/delete an access ticket by ID.",
            serde_json::json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Ticket UUID" } },
                "required": ["id"]
            }),
        ),
        // ---- role assignments ----
        tool_def(
            "add_target_role",
            "Assign a role to a target, granting users with that role access to the target.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": { "type": "string", "description": "Target UUID" },
                    "role_id": { "type": "string", "description": "Role UUID" }
                },
                "required": ["target_id", "role_id"]
            }),
        ),
        tool_def(
            "delete_target_role",
            "Remove a role from a target.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": { "type": "string", "description": "Target UUID" },
                    "role_id": { "type": "string", "description": "Role UUID" }
                },
                "required": ["target_id", "role_id"]
            }),
        ),
        tool_def(
            "add_user_role",
            "Assign a role to a user.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "user_id": { "type": "string", "description": "User UUID" },
                    "role_id": { "type": "string", "description": "Role UUID" }
                },
                "required": ["user_id", "role_id"]
            }),
        ),
        tool_def(
            "delete_user_role",
            "Remove a role from a user.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "user_id": { "type": "string", "description": "User UUID" },
                    "role_id": { "type": "string", "description": "Role UUID" }
                },
                "required": ["user_id", "role_id"]
            }),
        ),
    ]
}

fn tool_def(name: &str, description: &str, input_schema: Value) -> Value {
    serde_json::json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}
