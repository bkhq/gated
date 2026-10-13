use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Alias::new("management_audit"))
                    .col(
                        ColumnDef::new(Alias::new("id"))
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Alias::new("text")).text().not_null())
                    .col(ColumnDef::new(Alias::new("values")).json().not_null())
                    .col(
                        ColumnDef::new(Alias::new("timestamp"))
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Alias::new("session_id")).uuid().not_null())
                    .col(ColumnDef::new(Alias::new("username")).string())
                    .to_owned(),
            )
            .await?;
        for column in ["timestamp", "username", "session_id"] {
            manager
                .create_index(
                    Index::create()
                        .name(format!("management_audit_{column}"))
                        .table(Alias::new("management_audit"))
                        .col(Alias::new(column))
                        .to_owned(),
                )
                .await?;
        }
        // Preserve historical records in their original store. The new table starts at cutover.
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Copy new audit records back before removing the dedicated table on rollback.
        let db = manager.get_connection();
        if manager.has_table("log").await? {
            let quote = if manager.get_database_backend() == sea_orm::DbBackend::MySql {
                "`"
            } else {
                "\""
            };
            db.execute_unprepared(&format!("INSERT INTO log (id, text, {quote}values{quote}, timestamp, session_id, username) SELECT id, text, {quote}values{quote}, timestamp, session_id, username FROM management_audit WHERE id NOT IN (SELECT id FROM log)")).await?;
        }
        manager
            .drop_table(
                Table::drop()
                    .table(Alias::new("management_audit"))
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[cfg(all(test, feature = "sqlite"))]
#[allow(clippy::unwrap_used, reason = "Test fixtures fail immediately on invalid setup")]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    #[tokio::test]
    async fn rollback_preserves_management_audit_history() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        let manager = SchemaManager::new(&db);
        Migration.up(&manager).await.unwrap();
        db.execute_unprepared("CREATE TABLE log AS SELECT * FROM management_audit WHERE 0")
            .await
            .unwrap();
        db.execute_unprepared("INSERT INTO management_audit (id, text, \"values\", timestamp, session_id, username) VALUES ('1', 'management action', '{}', '2026-09-13', '0', 'alice')").await.unwrap();
        Migration.down(&manager).await.unwrap();
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT username FROM log WHERE id = '1'",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<String>("", "username").unwrap(), "alice");
    }
}
