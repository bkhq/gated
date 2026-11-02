use sea_orm_migration::prelude::*;

// No-op carrier. Earlier revisions of this crate shipped a real
// `m00003_accounts` migration; its schema has since been folded into
// `m00001_initial`. We keep an empty entry under the original file stem so
// sea-orm-migration's `seaql_migrations` consistency check does not reject
// dev databases that still have a row recorded for this version.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
