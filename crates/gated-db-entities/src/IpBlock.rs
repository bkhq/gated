use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;
use serde::Serialize;
use utoipa::ToSchema;

/// A client address refused at sign-in. The row outlives the block so a
/// repeat offender gets a longer one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, DeriveEntityModel, ToSchema)]
#[sea_orm(table_name = "ip_blocks")]
#[schema(as = IpBlock)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub ip_address: String,
    /// How many blocks in a row this address has earned.
    pub block_count: i32,
    pub blocked_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
