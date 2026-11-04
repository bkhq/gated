use sea_orm_migration::prelude::*;

// The last reachability check of each target, and how often targets are
// checked automatically (`parameters.target_check_interval_hours`, 0 = off).
// Rows are removed with their target by the API; no foreign key, to match
// the other target tables.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum TargetStatus {
    Table,
    TargetId,
    CheckedAt,
    Reachable,
    LatencyMs,
    Error,
}

#[derive(DeriveIden)]
enum Parameters {
    Table,
    TargetCheckIntervalHours,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(TargetStatus::Table)
                    .col(
                        ColumnDef::new(TargetStatus::TargetId)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(TargetStatus::CheckedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(TargetStatus::Reachable).boolean().not_null())
                    .col(ColumnDef::new(TargetStatus::LatencyMs).integer().null())
                    .col(ColumnDef::new(TargetStatus::Error).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .add_column(
                        ColumnDef::new(Parameters::TargetCheckIntervalHours)
                            .integer()
                            .not_null()
                            .default(24),
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
                    .drop_column(Parameters::TargetCheckIntervalHours)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(Table::drop().table(TargetStatus::Table).to_owned())
            .await
    }
}
