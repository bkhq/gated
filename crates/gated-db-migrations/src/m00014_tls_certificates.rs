use sea_orm_migration::prelude::*;

// TLS certificates served by the HTTP proxy, MySQL and PostgreSQL listeners,
// one per listener. They live in the database (encrypted with it when at-rest
// encryption is on); only the admin listener keeps certificate files.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Alias::new("tls_certificates"))
                    .col(
                        ColumnDef::new(Alias::new("listener"))
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("certificate_pem"))
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("private_key_pem"))
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("created"))
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(Alias::new("tls_certificates"))
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}
