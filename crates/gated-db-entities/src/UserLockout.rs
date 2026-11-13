use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;
use serde::Serialize;
use utoipa::ToSchema;

/// A user refused at sign-in after too many failed attempts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, DeriveEntityModel, ToSchema)]
#[sea_orm(table_name = "user_lockouts")]
#[schema(as = UserLockout)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub username: String,
    pub locked_at: DateTime<Utc>,
    /// `None`: locked until an administrator lifts it.
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
