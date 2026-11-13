use sea_orm_migration::prelude::*;

// Longest lifetime a user may give an API token; NULL = no limit.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum Parameters {
    Table,
    MaxApiTokenDurationSeconds,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .add_column(
                        ColumnDef::new(Parameters::MaxApiTokenDurationSeconds)
                            .big_integer()
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
                    .table(Parameters::Table)
                    .drop_column(Parameters::MaxApiTokenDurationSeconds)
                    .to_owned(),
            )
            .await
    }
}
