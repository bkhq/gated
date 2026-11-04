use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;
use uuid::Uuid;

/// The last reachability check of a target.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "target_status")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub target_id: Uuid,
    pub checked_at: DateTime<Utc>,
    pub reachable: bool,
    pub latency_ms: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
