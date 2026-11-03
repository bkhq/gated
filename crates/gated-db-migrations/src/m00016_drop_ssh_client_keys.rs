use sea_orm_migration::prelude::*;

// Gateway-wide SSH client keys are gone: target auth keys belong to ssh-key
// accounts or to the target. Only host keys stay in `ssh_keys`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .exec_stmt(
                Query::delete()
                    .from_table(Alias::new("ssh_keys"))
                    .and_where(Expr::col(Alias::new("kind")).eq("client"))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
