use sea_orm_migration::prelude::*;

// When a role assignment stops granting anything; NULL = never.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum UserRoles {
    Table,
    ExpiresAt,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(UserRoles::Table)
                    .add_column(
                        ColumnDef::new(UserRoles::ExpiresAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(UserRoles::Table)
                    .drop_column(UserRoles::ExpiresAt)
                    .to_owned(),
            )
            .await
    }
}
