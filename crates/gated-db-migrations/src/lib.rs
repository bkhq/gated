#![forbid(unsafe_code)]
use sea_orm::DatabaseConnection;
use sea_orm_migration::MigrationTrait;
use sea_orm_migration::prelude::*;

mod m00001_initial;
mod m00002_sql_console_rate_limits;
mod m00003_accounts;
mod m00004_sso_iss_sub;
mod m00005_hash_api_token_secrets;
mod m00006_hash_ticket_secrets;
mod m00007_command_acl_rules;
mod m00008_terminal_watermark;
mod m00009_unique_names;
mod m00010_management_audit;
mod m00011_site_title;
mod m00012_role_file_transfer;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        // m00002 and m00003 are no-op carriers preserved so sea-orm-migration's
        // `seaql_migrations` consistency check does not reject dev databases
        // that already have rows recorded for those names (their
        // schemas are part of m00001_initial).
        vec![
            Box::new(m00001_initial::Migration),
            Box::new(m00002_sql_console_rate_limits::Migration),
            Box::new(m00003_accounts::Migration),
            Box::new(m00004_sso_iss_sub::Migration),
            Box::new(m00005_hash_api_token_secrets::Migration),
            Box::new(m00006_hash_ticket_secrets::Migration),
            Box::new(m00007_command_acl_rules::Migration),
            Box::new(m00008_terminal_watermark::Migration),
            Box::new(m00009_unique_names::Migration),
            Box::new(m00010_management_audit::Migration),
            Box::new(m00011_site_title::Migration),
            Box::new(m00012_role_file_transfer::Migration),
        ]
    }
}

pub async fn migrate_database(connection: &DatabaseConnection) -> Result<(), DbErr> {
    Migrator::up(connection, None).await
}

#[cfg(all(test, feature = "sqlite"))]
mod tests {
    use sea_orm::{ConnectionTrait, Database, Statement};
    use sea_orm_migration::MigratorTrait;

    use super::Migrator;

    #[tokio::test]
    async fn migrates_up_and_down_on_sqlite() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite memory database");

        Migrator::up(&db, None)
            .await
            .expect("run all migrations up");
        Migrator::down(&db, None)
            .await
            .expect("run all migrations down");
    }

    // Reproduces the desync the m00002/m00003 carriers exist to
    // tolerate: a database that has rows in `seaql_migrations` for
    // those versions. Without the carriers, sea-orm-migration's
    // `get_migration_with_status` consistency check fails with
    // "Migration file of version '<name>' is missing".
    #[tokio::test]
    async fn up_tolerates_preexisting_dropped_migration_rows() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite memory database");

        // Hand-create just the `seaql_migrations` table that sea-orm-migration
        // would create on first `up`, and seed it as if the old binary had
        // already applied all three historical migrations. We deliberately do
        // NOT call `Migrator::up` first — that would conflate "carriers are in
        // code, so the rows are inserted naturally" with "carriers tolerate
        // pre-existing rows", which is the property under test.
        let backend = db.get_database_backend();
        db.execute(Statement::from_string(
            backend,
            "CREATE TABLE seaql_migrations (\
                version VARCHAR NOT NULL PRIMARY KEY, \
                applied_at BIGINT NOT NULL\
             )"
            .to_owned(),
        ))
        .await
        .expect("create seaql_migrations table");
        for (name, applied_at) in [
            ("m00001_initial", 1_700_000_000_i64),
            ("m00002_sql_console_rate_limits", 1_700_000_001_i64),
            ("m00003_accounts", 1_700_000_002_i64),
        ] {
            db.execute(Statement::from_sql_and_values(
                backend,
                "INSERT INTO seaql_migrations (version, applied_at) VALUES (?, ?)",
                [name.into(), applied_at.into()],
            ))
            .await
            .expect("seed seaql_migrations row");
        }

        // A desynced database that has m00001..m00003 recorded as applied
        // also has the schema those migrations created. Reproduce the tables the
        // later migrations alter (m00004 → credentials_sso, m00005 → parameters,
        // m00012 → roles) so `up` exercises the genuine ALTER paths rather than
        // tripping over a table the synthetic seed never created.
        db.execute(Statement::from_string(
            backend,
            "CREATE TABLE credentials_sso (\
                id BLOB NOT NULL PRIMARY KEY, \
                user_id BLOB NOT NULL, \
                provider TEXT, \
                email TEXT NOT NULL\
             )"
            .to_owned(),
        ))
        .await
        .expect("create credentials_sso table");
        db.execute(Statement::from_string(
            backend,
            "CREATE TABLE parameters (\
                id BLOB NOT NULL PRIMARY KEY\
             )"
            .to_owned(),
        ))
        .await
        .expect("create parameters table");
        db.execute(Statement::from_string(
            backend,
            "CREATE TABLE roles (\
                id BLOB NOT NULL PRIMARY KEY, \
                name TEXT NOT NULL\
             )"
            .to_owned(),
        ))
        .await
        .expect("create roles table");

        // The whole point of the carriers: with pre-existing rows for names
        // no longer carried by code, `up` would fail the consistency check.
        // With the carriers restored, only genuinely-pending migrations run.
        Migrator::up(&db, None)
            .await
            .expect("up against a desynced seaql_migrations table");
    }
}
