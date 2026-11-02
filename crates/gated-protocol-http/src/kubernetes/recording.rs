//! Kubernetes-flavor-specific recording helpers: `kubectl exec`/`attach`
//! terminal recordings (the recorder is the generic `TerminalRecorder`
//! from `gated-core`; only the metadata extraction is K8s-specific).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use anyhow::Context;
use gated_common::SessionId;
use gated_core::recordings::{SessionRecordings, TerminalRecorder};
use regex::Regex;
use tokio::sync::Mutex;
use url::Url;

use crate::recording::SessionRecordingMetadata;

static EXEC_URL_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    #[allow(
        clippy::unwrap_used,
        reason = "static regex pattern is valid at compile time"
    )]
    Regex::new(r"^/api/v1/namespaces/([^/]+)/pods/([^/]+)/(exec|attach)$").unwrap()
});

pub async fn start_recording_exec(
    session_id: &SessionId,
    recordings: &Arc<Mutex<SessionRecordings>>,
    metadata: Option<SessionRecordingMetadata>,
) -> anyhow::Result<TerminalRecorder> {
    let mut recordings = recordings.lock().await;
    recordings
        .start::<TerminalRecorder, _>(session_id, None, metadata)
        .await
        .context("starting recording")
}

pub fn deduce_exec_recording_metadata(target_url: &Url) -> Option<SessionRecordingMetadata> {
    let path = target_url.path();
    if let Some(captures) = EXEC_URL_REGEX.captures(path) {
        let namespace = captures.get(1).map_or("unknown", |m| m.as_str()).into();
        let pod = captures.get(2).map_or("unknown", |m| m.as_str()).into();
        let operation = captures.get(3).map_or("unknown", |m| m.as_str());
        let query = target_url.query().unwrap_or_default();
        let parsed_query: HashMap<_, _> = url::form_urlencoded::parse(query.as_bytes()).collect();
        let command = parsed_query
            .get("command")
            .cloned()
            .unwrap_or("unknown".into())
            .into();
        let container = parsed_query
            .get("container")
            .cloned()
            .unwrap_or("unknown".into())
            .into();
        return match operation {
            "exec" => Some(SessionRecordingMetadata::Exec {
                namespace,
                pod,
                container,
                command,
            }),
            "attach" => Some(SessionRecordingMetadata::Attach {
                namespace,
                pod,
                container,
            }),
            _ => None,
        };
    }
    None
}
