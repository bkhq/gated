use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let names = [
            ("users", "username", "users_username_unique"),
            ("targets", "name", "targets_name_unique"),
        ];
        // Preflight both tables before adding either index; never rename or delete operator data.
        for (table, column, _) in names {
            if !manager.has_table(table).await? {
                continue;
            }
            let duplicates = db.query_one(sea_orm::Statement::from_string(
                manager.get_database_backend(),
                format!("SELECT COUNT(*) AS n FROM {table} GROUP BY {column} HAVING COUNT(*) > 1 LIMIT 1"),
            )).await?;
            if duplicates.is_some() {
                return Err(DbErr::Custom(format!("Cannot enforce unique {table}.{column}: duplicate names exist; resolve duplicates explicitly and retry migration")));
            }
        }
        for (table, column, index) in names {
            if manager.has_table(table).await? {
                manager
                    .create_index(
                        Index::create()
                            .name(index)
                            .table(Alias::new(table))
                            .col(Alias::new(column))
                            .unique()
                            .to_owned(),
                    )
                    .await?;
            }
        }
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for (table, index) in [
            ("users", "users_username_unique"),
            ("targets", "targets_name_unique"),
        ] {
            if manager.has_table(table).await? {
                manager
                    .drop_index(
                        Index::drop()
                            .name(index)
                            .table(Alias::new(table))
                            .to_owned(),
                    )
                    .await?;
            }
        }
        Ok(())
    }
}

#[cfg(all(test, feature = "sqlite"))]
#[allow(
    clippy::unwrap_used,
    reason = "Test fixtures fail immediately on invalid setup"
)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database, DatabaseConnection};

    async fn database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        db.execute_unprepared(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)",
        )
        .await
        .unwrap();
        db.execute_unprepared("CREATE TABLE targets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .await
            .unwrap();
        db
    }

    #[tokio::test]
    async fn concurrent_names_and_updates_are_unique() {
        let db = database().await;
        Migration.up(&SchemaManager::new(&db)).await.unwrap();
        for (table, column) in [("users", "username"), ("targets", "name")] {
            let sql = format!("INSERT INTO {table} ({column}) VALUES ('shared')");
            let (a, b) = tokio::join!(db.execute_unprepared(&sql), db.execute_unprepared(&sql));
            assert_ne!(a.is_ok(), b.is_ok());
            db.execute_unprepared(&format!("INSERT INTO {table} ({column}) VALUES ('other')"))
                .await
                .unwrap();
            assert!(db
                .execute_unprepared(&format!(
                    "UPDATE {table} SET {column} = 'shared' WHERE {column} = 'other'"
                ))
                .await
                .is_err());
        }
        Migration.down(&SchemaManager::new(&db)).await.unwrap();
        db.execute_unprepared("INSERT INTO users (username) VALUES ('shared')")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn duplicate_preflight_preserves_all_rows() {
        let db = database().await;
        db.execute_unprepared("INSERT INTO targets (name) VALUES ('duplicate'), ('duplicate')")
            .await
            .unwrap();
        let error = Migration.up(&SchemaManager::new(&db)).await.unwrap_err();
        assert!(error.to_string().contains("duplicate"));
        let rows = db
            .query_one(sea_orm::Statement::from_string(
                sea_orm::DbBackend::Sqlite,
                "SELECT COUNT(*) AS n FROM targets",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rows.try_get::<i64>("", "n").unwrap(), 2);
    }
}
