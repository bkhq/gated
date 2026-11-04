use sea_orm_migration::prelude::*;

// Adds `target_roles.account_id`: the account members of that role sign in
// to the target with. Null keeps the target's default login. The account
// must be bound to the target; that is enforced by the API, not a foreign
// key, because SQLite cannot add one to an existing table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum TargetRoles {
    Table,
    AccountId,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(TargetRoles::Table)
                    .add_column(ColumnDef::new(TargetRoles::AccountId).integer().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(TargetRoles::Table)
                    .drop_column(TargetRoles::AccountId)
                    .to_owned(),
            )
            .await
    }
}
