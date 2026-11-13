use sea_orm_migration::prelude::*;

// Adds `roles.allow_clipboard`: whether desktop sessions (RDP, VNC) granted
// by the role may exchange clipboard text. Off for every role by default.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum Roles {
    Table,
    AllowClipboard,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Roles::Table)
                    .add_column(
                        ColumnDef::new(Roles::AllowClipboard)
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
                    .table(Roles::Table)
                    .drop_column(Roles::AllowClipboard)
                    .to_owned(),
            )
            .await
    }
}
