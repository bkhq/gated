use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;
use sea_orm::query::JsonValue;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, utoipa::ToSchema)]
#[sea_orm(table_name = "log")]
#[schema(as = LogEntry)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub text: String,
    pub values: JsonValue,
    pub timestamp: DateTime<Utc>,
    pub session_id: Uuid,
    pub username: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
