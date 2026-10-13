use gated_db_entities::{LogEntry, ManagementAudit};
use sea_orm::ActiveModelTrait;
use sea_orm::query::JsonValue;
use std::sync::OnceLock;
use tracing::*;
use tracing_subscriber::Layer;
use tracing_subscriber::registry::LookupSpan;
use uuid::Uuid;

use super::layer::ValuesLogLayer;
use super::values::SerializedRecordValues;
use crate::SharedDatabaseConnection;

static LOG_SENDER: OnceLock<tokio::sync::broadcast::Sender<LogEntry::ActiveModel>> =
    OnceLock::new();

pub fn make_database_logger_layer<S>() -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let _ = LOG_SENDER.set(tokio::sync::broadcast::channel(1024).0);
    ValuesLogLayer::new(|values| {
        if let Some(sender) = LOG_SENDER.get()
            && let Some(entry) = values_to_log_entry_data(values)
        {
            let _ = sender.send(entry);
        }
    })
}

pub fn install_database_logger(database: SharedDatabaseConnection) {
    tokio::spawn(async move {
        #[allow(
            clippy::expect_used,
            reason = "LOG_SENDER is set once during install_logging; install_database_logger is only called after that"
        )]
        let mut receiver = LOG_SENDER
            .get()
            .expect("Log sender not ready yet")
            .subscribe();
        loop {
            match receiver.recv().await {
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    error!(
                        count,
                        "Audit buffer overflow; continuing with available events"
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Ok(log_entry) => {
                    let Ok(database) = crate::db_required(&database).await else {
                        continue;
                    };
                    let result = if log_entry.session_id.as_ref().is_nil() {
                        ManagementAudit::ActiveModel {
                            id: log_entry.id,
                            text: log_entry.text,
                            values: log_entry.values,
                            timestamp: log_entry.timestamp,
                            session_id: log_entry.session_id,
                            username: log_entry.username,
                        }
                        .insert(&database)
                        .await
                        .map(|_| ())
                    } else {
                        log_entry.insert(&database).await.map(|_| ())
                    };
                    if let Err(error) = result {
                        error!(?error, "Failed to store log entry");
                    }
                }
            }
        }
    });
}

fn values_to_log_entry_data(mut values: SerializedRecordValues) -> Option<LogEntry::ActiveModel> {
    let session_id = (*values).remove("session");
    let username = (*values)
        .remove("session_username")
        .or_else(|| (*values).remove("username"));
    let message = (*values).remove("message").unwrap_or_default();

    use sea_orm::ActiveValue::Set;
    let session_id = session_id
        .and_then(|x| Uuid::parse_str(&x).ok())
        .unwrap_or_default();

    Some(LogEntry::ActiveModel {
        id: Set(Uuid::new_v4()),
        text: Set(message),
        values: Set(values
            .into_values()
            .into_iter()
            .map(|(k, v)| (k, JsonValue::from(v)))
            .collect()),
        session_id: Set(session_id),
        username: Set(username),
        timestamp: Set(chrono::Utc::now()),
    })
}
