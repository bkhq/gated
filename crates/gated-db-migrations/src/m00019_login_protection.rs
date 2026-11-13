use sea_orm_migration::prelude::*;

// Login protection: failed password and OTP attempts, the address blocks and
// user lockouts they lead to, and the thresholds in `parameters`.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum FailedLoginAttempts {
    Table,
    Id,
    Username,
    RemoteIp,
    Timestamp,
}

#[derive(DeriveIden)]
enum IpBlocks {
    Table,
    IpAddress,
    BlockCount,
    BlockedAt,
    ExpiresAt,
}

#[derive(DeriveIden)]
enum UserLockouts {
    Table,
    Username,
    LockedAt,
    ExpiresAt,
}

#[derive(DeriveIden)]
enum Parameters {
    Table,
    LoginProtectionEnabled,
    LpIpMaxAttempts,
    LpIpWindowSeconds,
    LpIpBlockSeconds,
    LpIpMaxBlockSeconds,
    LpUserMaxAttempts,
    LpUserWindowSeconds,
    LpUserLockoutSeconds,
}

const INTEGER_PARAMETERS: [(Parameters, i32); 7] = [
    (Parameters::LpIpMaxAttempts, 20),
    (Parameters::LpIpWindowSeconds, 900),
    (Parameters::LpIpBlockSeconds, 1800),
    (Parameters::LpIpMaxBlockSeconds, 86400),
    (Parameters::LpUserMaxAttempts, 10),
    (Parameters::LpUserWindowSeconds, 3600),
    (Parameters::LpUserLockoutSeconds, 3600),
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(FailedLoginAttempts::Table)
                    .col(
                        ColumnDef::new(FailedLoginAttempts::Id)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(FailedLoginAttempts::Username)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FailedLoginAttempts::RemoteIp)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(FailedLoginAttempts::Timestamp)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        for (name, column) in [
            (
                "failed_login_attempts_remote_ip",
                FailedLoginAttempts::RemoteIp,
            ),
            (
                "failed_login_attempts_username",
                FailedLoginAttempts::Username,
            ),
        ] {
            manager
                .create_index(
                    Index::create()
                        .name(name)
                        .table(FailedLoginAttempts::Table)
                        .col(column)
                        .col(FailedLoginAttempts::Timestamp)
                        .to_owned(),
                )
                .await?;
        }
        manager
            .create_table(
                Table::create()
                    .table(IpBlocks::Table)
                    .col(
                        ColumnDef::new(IpBlocks::IpAddress)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(IpBlocks::BlockCount).integer().not_null())
                    .col(
                        ColumnDef::new(IpBlocks::BlockedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(IpBlocks::ExpiresAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(UserLockouts::Table)
                    .col(
                        ColumnDef::new(UserLockouts::Username)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(UserLockouts::LockedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UserLockouts::ExpiresAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Parameters::Table)
                    .add_column(
                        ColumnDef::new(Parameters::LoginProtectionEnabled)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .to_owned(),
            )
            .await?;
        // One column per statement: SQLite cannot add several at once.
        for (column, default) in INTEGER_PARAMETERS {
            manager
                .alter_table(
                    Table::alter()
                        .table(Parameters::Table)
                        .add_column(ColumnDef::new(column).integer().not_null().default(default))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for (column, _) in INTEGER_PARAMETERS {
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
                    .drop_column(Parameters::LoginProtectionEnabled)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(Table::drop().table(UserLockouts::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(IpBlocks::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(FailedLoginAttempts::Table).to_owned())
            .await
    }
}
