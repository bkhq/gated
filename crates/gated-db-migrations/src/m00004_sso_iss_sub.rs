use sea_orm_migration::prelude::*;

// Adds the OIDC `iss` (issuer) and `sub` (subject) columns to
// `credentials_sso`. These form the stable account identity used to resolve
// an OIDC login to a local user; previously linkage was by email
// alone, which allowed account takeover via a federated IdP.
//
// Both columns are nullable: pre-existing rows and credentials provisioned
// manually by an administrator carry no OIDC identity.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum CredentialsSso {
    Table,
    Iss,
    Sub,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Separate statements: SQLite only supports a single ADD COLUMN per
        // ALTER TABLE.
        manager
            .alter_table(
                Table::alter()
                    .table(CredentialsSso::Table)
                    .add_column(ColumnDef::new(CredentialsSso::Iss).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(CredentialsSso::Table)
                    .add_column(ColumnDef::new(CredentialsSso::Sub).text().null())
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(CredentialsSso::Table)
                    .drop_column(CredentialsSso::Sub)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(CredentialsSso::Table)
                    .drop_column(CredentialsSso::Iss)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}
