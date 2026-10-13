use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;
use sea_orm::sea_query::ForeignKeyAction;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize)]
#[sea_orm(table_name = "accounts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = true)]
    pub id: i32,
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub credentials: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub tags: Option<String>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub rotation_due_at: Option<DateTime<Utc>>,
}

impl Related<super::User::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::User.def()
    }
}

impl Related<super::Target::Entity> for Entity {
    fn to() -> RelationDef {
        super::TargetAccount::Relation::Target.def()
    }

    fn via() -> Option<RelationDef> {
        Some(super::TargetAccount::Relation::Account.def().rev())
    }
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    User,
    TargetAccounts,
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::User => Entity::belongs_to(super::User::Entity)
                .from(Column::CreatedBy)
                .to(super::User::Column::Id)
                .on_delete(ForeignKeyAction::SetNull)
                .into(),
            Self::TargetAccounts => Entity::has_many(super::TargetAccount::Entity)
                .from(Column::Id)
                .to(super::TargetAccount::Column::AccountId)
                .into(),
        }
    }
}

impl ActiveModelBehavior for ActiveModel {}
