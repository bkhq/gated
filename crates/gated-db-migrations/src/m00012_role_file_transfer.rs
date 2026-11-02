use sea_orm_migration::prelude::*;

// Adds `roles.allow_file_transfer`. Existing roles keep SFTP access.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum Roles {
    Table,
    AllowFileTransfer,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .add_column(
                        ColumnDef::new(Roles::AllowFileTransfer)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .drop_column(Roles::AllowFileTransfer)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}
