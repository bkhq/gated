use chrono::{DateTime, Utc};
use gated_db_entities::Recording::RecordingKind;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::writer::RecordingWriter;
use super::{Error, Recorder, Result};

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum SqlAuditSessionMetadata {
    #[serde(rename = "sql-console-session")]
    SqlConsoleSession { target_kind: String, target: String },
    #[serde(rename = "mysql-proxy-session")]
    MySqlProxySession {
        target: String,
        database: Option<String>,
    },
    #[serde(rename = "postgres-proxy-session")]
    PostgresProxySession {
        target: String,
        database: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum SqlAuditRecordingItem {
    #[serde(rename = "sql-query")]
    Query {
        timestamp: DateTime<Utc>,
        target_kind: String,
        target: String,
        database: Option<String>,
        sql: String,
        statement_kind: String,
        readonly: Option<bool>,
        elapsed_ms: u64,
        success: bool,
        error: Option<String>,
    },
}

pub struct StructuredRecorder {
    writer: RecordingWriter,
}

impl StructuredRecorder {
    pub async fn write_item(&mut self, item: &SqlAuditRecordingItem) -> Result<()> {
        let mut serialized_item = serde_json::to_vec(item).map_err(Error::Serialization)?;
        serialized_item.push(b'\n');
        self.writer.write(&serialized_item).await?;
        Ok(())
    }
}

impl Recorder for StructuredRecorder {
    fn kind() -> RecordingKind {
        RecordingKind::SqlAudit
    }

    fn new(writer: RecordingWriter) -> Self {
        Self { writer }
    }
}

/// Session-level metadata for a shell-command audit stream, mirroring
/// [`SqlAuditSessionMetadata`]. One stream is opened per SSH session and each
/// reconstructed command is appended as a [`ShellCommandRecordingItem`].
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ShellCommandSessionMetadata {
    #[serde(rename = "ssh-shell-session")]
    SshShellSession {
        target: String,
        target_id: Option<Uuid>,
    },
}

/// A single reconstructed shell command with its command-ACL verdict, mirroring
/// [`SqlAuditRecordingItem`]. `origin` distinguishes the clean `exec` command
/// line from a best-effort `pty` line reconstructed from the raw keystroke
/// stream (see the SSH session's PTY filtering for the reconstruction limits).
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ShellCommandRecordingItem {
    #[serde(rename = "shell-command")]
    Command {
        timestamp: DateTime<Utc>,
        target: String,
        target_id: Option<Uuid>,
        user_id: Option<Uuid>,
        username: Option<String>,
        /// "exec" | "pty".
        origin: String,
        command: String,
        /// The deciding ACL verdict: "allow" | "deny" | "review".
        acl_action: String,
        acl_rule_id: Option<i64>,
        acl_rule_name: Option<String>,
        /// "allowed" | "blocked" | "blocked-review-pending".
        outcome: String,
    },
}

/// Persists one JSONL [`ShellCommandRecordingItem`] per reconstructed command.
/// A distinct [`RecordingKind::CommandAudit`] kind lets the records API query
/// shell-command audits independently of SQL audits.
pub struct CommandAuditRecorder {
    writer: RecordingWriter,
}

impl CommandAuditRecorder {
    pub async fn write_item(&mut self, item: &ShellCommandRecordingItem) -> Result<()> {
        let mut serialized_item = serde_json::to_vec(item).map_err(Error::Serialization)?;
        serialized_item.push(b'\n');
        self.writer.write(&serialized_item).await?;
        Ok(())
    }
}

impl Recorder for CommandAuditRecorder {
    fn kind() -> RecordingKind {
        RecordingKind::CommandAudit
    }

    fn new(writer: RecordingWriter) -> Self {
        Self { writer }
    }
}
