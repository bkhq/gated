use sea_orm_migration::prelude::*;

// Rules for new passwords; the defaults require nothing.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum Parameters {
    Table,
    PasswordMinLength,
    PasswordRequireUppercase,
    PasswordRequireLowercase,
    PasswordRequireDigits,
    PasswordRequireSpecial,
}

const FLAGS: [Parameters; 4] = [
    Parameters::PasswordRequireUppercase,
    Parameters::PasswordRequireLowercase,
    Parameters::PasswordRequireDigits,
    Parameters::PasswordRequireSpecial,
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .add_column(
                        ColumnDef::new(Parameters::PasswordMinLength)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        // One column per statement: SQLite cannot add several at once.
        for column in FLAGS {
            manager
                .alter_table(
                    Table::alter()
                        .table(Parameters::Table)
                        .add_column(ColumnDef::new(column).boolean().not_null().default(false))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in FLAGS {
            manager
                .alter_table(
                    Table::alter()
                        .table(Parameters::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .drop_column(Parameters::PasswordMinLength)
                    .to_owned(),
            )
            .await
    }
}
