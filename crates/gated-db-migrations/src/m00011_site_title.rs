use sea_orm_migration::prelude::*;

// Adds the optional `site_title` shown on the login page, the sidebar brand
// and the browser tab. NULL means the built-in "Gated" title.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum Parameters {
    Table,
    SiteTitle,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .add_column(ColumnDef::new(Parameters::SiteTitle).string().null())
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
                    .drop_column(Parameters::SiteTitle)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}
