use sea_orm::Schema;
use sea_orm_migration::prelude::*;

// Creates the `command_acl_rule` table backing the reusable command-ACL
// engine (see `gated_core::command_acl`). New controls are OFF by default:
// an empty ruleset allows everything, so this migration seeds no rows.
#[derive(DeriveMigrationName)]
pub struct Migration;

// Local entity definition mirroring `gated_db_entities::CommandAclRule`,
// frozen here so the migration's schema does not drift if the entity later
// changes (same pattern as m00001_initial).
mod command_acl_rule {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "command_acl_rule")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = true)]
        pub id: i32,
        pub name: String,
        pub enabled: bool,
        pub priority: i32,
        pub protocol: String,
        pub match_type: String,
        #[sea_orm(column_type = "Text")]
        pub pattern: String,
        pub action: String,
        pub target_id: Option<Uuid>,
        pub role_id: Option<Uuid>,
        #[sea_orm(column_type = "Text", nullable)]
        pub description: Option<String>,
        pub created_at: DateTimeUtc,
        pub updated_at: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = manager.get_database_backend();
        let schema = Schema::new(builder);

        manager
            .create_table(schema.create_table_from_entity(command_acl_rule::Entity))
            .await?;

        // Rules are evaluated by ascending priority, then id; index that path.
        manager
            .create_index(
                Index::create()
                    .name("idx_command_acl_rule_priority")
                    .table(command_acl_rule::Entity)
                    .col(command_acl_rule::Column::Priority)
                    .col(command_acl_rule::Column::Id)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(command_acl_rule::Entity).to_owned())
            .await?;
        Ok(())
    }
}
