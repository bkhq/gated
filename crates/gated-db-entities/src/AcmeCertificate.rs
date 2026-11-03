use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;

/// A listener whose certificate is issued and renewed through ACME.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "acme_certificates")]
pub struct Model {
    /// `admin`, `http`, `mysql` or `postgres`.
    #[sea_orm(primary_key, auto_increment = false)]
    pub listener: String,
    /// JSON array of DNS names.
    #[sea_orm(column_type = "Text")]
    pub domains: String,
    pub last_attempt: Option<DateTime<Utc>>,
    pub last_success: Option<DateTime<Utc>>,
    #[sea_orm(column_type = "Text", nullable)]
    pub last_error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
