use poem_openapi::Object;
use sea_orm::entity::prelude::*;
use sea_orm::sea_query::ForeignKeyAction;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Object)]
#[sea_orm(table_name = "target_accounts")]
#[oai(rename = "TargetAccount")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub target_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub account_id: i32,
    #[sea_orm(primary_key, auto_increment = false)]
    pub role: String,
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    Target,
    Account,
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::Target => Entity::belongs_to(super::Target::Entity)
                .from(Column::TargetId)
                .to(super::Target::Column::Id)
                .on_delete(ForeignKeyAction::Cascade)
                .into(),
            Self::Account => Entity::belongs_to(super::Account::Entity)
                .from(Column::AccountId)
                .to(super::Account::Column::Id)
                .on_delete(ForeignKeyAction::Restrict)
                .into(),
        }
    }
}

impl Related<super::Target::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Target.def()
    }
}

impl Related<super::Account::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Account.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
