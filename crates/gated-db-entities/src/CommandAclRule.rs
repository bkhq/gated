use chrono::{DateTime, Utc};
use poem_openapi::Object;
use sea_orm::entity::prelude::*;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Object)]
#[sea_orm(table_name = "command_acl_rule")]
#[oai(rename = "CommandAclRule")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = true)]
    pub id: i32,
    pub name: String,
    pub enabled: bool,
    /// Lower value is evaluated first.
    pub priority: i32,
    /// "ssh" | "mysql" | "postgres" | "any"
    pub protocol: String,
    /// "regex" | "keyword"
    pub match_type: String,
    #[sea_orm(column_type = "Text")]
    pub pattern: String,
    /// "allow" | "deny" | "review"
    pub action: String,
    /// Nullable scope: null = all targets.
    pub target_id: Option<Uuid>,
    /// Nullable scope: null = all roles.
    pub role_id: Option<Uuid>,
    #[sea_orm(column_type = "Text", nullable)]
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
