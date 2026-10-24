use sea_orm_migration::prelude::*;

// Adds the `terminal_watermark_enabled` flag to `parameters`. When set, the web
// terminal renders a frontend-only operator-identity + timestamp watermark
// overlay (purely visual — never injected into the PTY byte stream).
//
// Defaults to false so the feature is off for pre-existing rows and fresh
// installs alike.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum Parameters {
    Table,
    TerminalWatermarkEnabled,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .add_column(
                        ColumnDef::new(Parameters::TerminalWatermarkEnabled)
                            .boolean()
                            .not_null()
                            .default(false),
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
                    .table(Parameters::Table)
                    .drop_column(Parameters::TerminalWatermarkEnabled)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}
