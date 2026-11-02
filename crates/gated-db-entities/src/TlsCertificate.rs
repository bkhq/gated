use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "tls_certificates")]
pub struct Model {
    /// `http`, `mysql` or `postgres`.
    #[sea_orm(primary_key, auto_increment = false)]
    pub listener: String,
    #[sea_orm(column_type = "Text")]
    pub certificate_pem: String,
    #[sea_orm(column_type = "Text")]
    pub private_key_pem: String,
    pub created: DateTime<Utc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
