//! DB-backed loading for the command-ACL matcher.
//!
//! [`command_acl`](crate::command_acl) is deliberately DB-free: it evaluates a
//! preloaded ruleset. This module is the thin bridge that reads the
//! `command_acl_rule` and `user_roles` tables and feeds
//! [`command_acl::evaluate`](crate::command_acl::evaluate). It is consumed by
//! the DB proxy (MySQL/Postgres) command-filtering paths.
//!
//! **Default OFF:** with no enabled rules the ruleset is empty and every
//! command evaluates to [`AclAction::Allow`](crate::command_acl::AclAction),
//! so existing deployments see no behavior change.

use gated_db_entities::{CommandAclRule, UserRoleAssignment};
use sea_orm::{ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder};
use uuid::Uuid;

use crate::command_acl::{AclContext, AclDecision, CommandAclRuleView, evaluate};

/// Map a `command_acl_rule` row into the DB-free matcher view. The entity's
/// `i32` id widens to the view's `i64`; every other column maps 1:1.
fn to_rule_view(model: &CommandAclRule::Model) -> CommandAclRuleView {
    CommandAclRuleView {
        id: i64::from(model.id),
        name: model.name.clone(),
        enabled: model.enabled,
        priority: model.priority,
        protocol: model.protocol.clone(),
        match_type: model.match_type.clone(),
        pattern: model.pattern.clone(),
        action: model.action.clone(),
        target_id: model.target_id,
        role_id: model.role_id,
    }
}

/// Load every enabled ACL rule, ordered the same way the matcher expects
/// (ascending `priority`, then `id`). Disabled rules are filtered out at the DB.
pub async fn load_enabled_rules(db: &DatabaseConnection) -> Result<Vec<CommandAclRuleView>, DbErr> {
    let rows = CommandAclRule::Entity::find()
        .filter(CommandAclRule::Column::Enabled.eq(true))
        .order_by_asc(CommandAclRule::Column::Priority)
        .order_by_asc(CommandAclRule::Column::Id)
        .all(db)
        .await?;
    Ok(rows.iter().map(to_rule_view).collect())
}

/// Resolve the role UUIDs assigned to `user_id` (from the `user_roles` table).
/// Used to match role-scoped ACL rules.
pub async fn load_user_role_ids(
    db: &DatabaseConnection,
    user_id: Uuid,
) -> Result<Vec<Uuid>, DbErr> {
    let rows = UserRoleAssignment::Entity::find()
        .filter(UserRoleAssignment::Column::UserId.eq(user_id))
        .all(db)
        .await?;
    Ok(rows.into_iter().map(|r| r.role_id).collect())
}

/// Per-session command-ACL enforcer for the DB proxies.
///
/// Captures the immutable session scope — the target and the acting user's
/// roles — resolved once at authorization time. Rules are (re)loaded from the
/// DB on every [`evaluate`](Self::evaluate) call so administrator edits take
/// effect mid-session without reconnecting.
pub struct DbCommandAclEnforcer {
    db: DatabaseConnection,
    target_id: Uuid,
    role_ids: Vec<Uuid>,
}

impl DbCommandAclEnforcer {
    /// Build the enforcer, resolving the user's roles up front.
    pub async fn new(
        db: DatabaseConnection,
        target_id: Uuid,
        user_id: Uuid,
    ) -> Result<Self, DbErr> {
        let role_ids = load_user_role_ids(&db, user_id).await?;
        Ok(Self {
            db,
            target_id,
            role_ids,
        })
    }

    /// Evaluate one command for `protocol` ("mysql" | "postgres") against the
    /// current enabled ruleset within this session's scope. An empty ruleset
    /// (or no match) yields [`AclAction::Allow`](crate::command_acl::AclAction).
    pub async fn evaluate(&self, protocol: &str, command: &str) -> Result<AclDecision, DbErr> {
        let rules = load_enabled_rules(&self.db).await?;
        let ctx = AclContext {
            protocol,
            command,
            target_id: Some(self.target_id),
            role_ids: &self.role_ids,
        };
        Ok(evaluate(&rules, &ctx))
    }
}
