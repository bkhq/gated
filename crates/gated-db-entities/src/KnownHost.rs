use sea_orm::entity::prelude::*;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, utoipa::ToSchema)]
#[sea_orm(table_name = "known_hosts")]
#[schema(as = SSHKnownHost)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub host: String,
    pub port: i32,
    pub key_type: String,
    pub key_base64: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

impl Model {
    pub fn key_openssh(&self) -> String {
        format!("{} {}", self.key_type, self.key_base64)
    }
}
