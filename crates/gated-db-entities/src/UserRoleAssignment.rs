use chrono::{DateTime, Utc};
use sea_orm::Condition;
use sea_orm::entity::prelude::*;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, utoipa::ToSchema)]
#[sea_orm(table_name = "user_roles")]
#[schema(as = UserRoleAssignment)]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = true)]
    pub id: i32,
    pub user_id: Uuid,
    pub role_id: Uuid,
    /// The assignment grants nothing from this time on; `None` = never.
    pub expires_at: Option<DateTime<Utc>>,
}

impl Entity {
    /// Selects the assignments that have not expired.
    pub fn unexpired() -> Condition {
        Condition::any()
            .add(Column::ExpiresAt.is_null())
            .add(Column::ExpiresAt.gt(Utc::now()))
    }

    /// How many assignments expired after `since` and up to `until`.
    pub async fn expired_between<C: ConnectionTrait>(
        db: &C,
        since: DateTime<Utc>,
        until: DateTime<Utc>,
    ) -> Result<u64, DbErr> {
        Self::find()
            .filter(Column::ExpiresAt.gt(since))
            .filter(Column::ExpiresAt.lte(until))
            .count(db)
            .await
    }
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    User,
    Role,
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::User => Entity::belongs_to(super::User::Entity)
                .from(Column::UserId)
                .to(super::User::Column::Id)
                .into(),
            Self::Role => Entity::belongs_to(super::Role::Entity)
                .from(Column::RoleId)
                .to(super::Role::Column::Id)
                .into(),
        }
    }
}

impl Related<super::Role::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Role.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
