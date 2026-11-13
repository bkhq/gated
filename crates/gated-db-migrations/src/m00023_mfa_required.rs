use sea_orm_migration::prelude::*;

// Makes an OTP device mandatory for every user; off by default.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum Parameters {
    Table,
    MfaRequired,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .add_column(
                        ColumnDef::new(Parameters::MfaRequired)
                            .boolean()
                            .not_null()
                            .default(false),
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
                    .drop_column(Parameters::MfaRequired)
                    .to_owned(),
            )
            .await
    }
}
