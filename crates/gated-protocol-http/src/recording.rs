use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use gated_common::{HttpProxyFlavor, SessionId};
use gated_core::recordings::{Recorder, RecordingWriter, SessionRecordings};
use gated_db_entities::Recording::RecordingKind;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::engine::HttpProxyRecorder;

/// API-visible projection of a recorded HTTP proxy exchange.  Bodies are
/// best-effort JSON-decoded for human inspection; non-JSON bodies surface
/// as `null`.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[schema(as = HttpProxyRecordingItem)]
pub struct HttpProxyRecordingItemApiObject {
    pub timestamp: DateTime<Utc>,
    pub request_method: String,
    pub request_path: String,
    pub request_body: serde_json::Value,
    pub response_status: Option<u16>,
    pub response_body: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HttpProxyRecordingItem {
    pub timestamp: DateTime<Utc>,
    pub request_method: String,
    pub request_path: String,
    pub request_headers: HashMap<String, String>,
    #[serde(with = "gated_common::helpers::serde_base64")]
    pub request_body: Bytes,
    pub response_status: Option<u16>,
    pub response_body: Option<Vec<u8>>,
}

impl From<HttpProxyRecordingItem> for HttpProxyRecordingItemApiObject {
    fn from(item: HttpProxyRecordingItem) -> Self {
        HttpProxyRecordingItemApiObject {
            timestamp: item.timestamp,
            request_method: item.request_method,
            request_path: item.request_path,
            request_body: serde_json::from_slice(&item.request_body[..])
                .unwrap_or(serde_json::Value::Null),
            response_status: item.response_status,
            response_body: item
                .response_body
                .and_then(|body| serde_json::from_slice(&body[..]).ok())
                .unwrap_or(serde_json::Value::Null),
        }
    }
}

/// Metadata serialised into a recording's header. `flavor` lets the audit
/// UI filter Generic from Kubernetes traffic on top of the unified
/// `RecordingKind::HttpProxy`.
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum SessionRecordingMetadata {
    #[serde(rename = "http-proxy")]
    HttpProxy { flavor: HttpProxyFlavor },
    #[serde(rename = "kubernetes-exec")]
    Exec {
        namespace: String,
        pod: String,
        container: String,
        command: String,
    },
    #[serde(rename = "kubernetes-attach")]
    Attach {
        namespace: String,
        pod: String,
        container: String,
    },
}

pub struct HttpProxyRecorderImpl {
    writer: RecordingWriter,
}

impl HttpProxyRecorderImpl {
    async fn write_item(
        &mut self,
        item: &HttpProxyRecordingItem,
    ) -> Result<(), gated_core::recordings::Error> {
        let mut serialized_item =
            serde_json::to_vec(&item).map_err(gated_core::recordings::Error::Serialization)?;
        serialized_item.push(b'\n');
        self.writer.write(&serialized_item).await?;
        Ok(())
    }
}

impl HttpProxyRecorder for HttpProxyRecorderImpl {
    async fn record_response(
        &mut self,
        method: &str,
        path: &str,
        headers: HashMap<String, String>,
        request_body: &[u8],
        status: u16,
        response_body: &[u8],
    ) -> Result<(), gated_core::recordings::Error> {
        self.write_item(&HttpProxyRecordingItem {
            timestamp: Utc::now(),
            request_method: method.to_string(),
            request_path: path.to_string(),
            request_headers: headers,
            request_body: Bytes::from(request_body.to_vec()),
            response_status: Some(status),
            response_body: Some(response_body.to_vec()),
        })
        .await
    }
}

impl Recorder for HttpProxyRecorderImpl {
    fn kind() -> RecordingKind {
        RecordingKind::HttpProxy
    }

    fn new(writer: RecordingWriter) -> Self {
        HttpProxyRecorderImpl { writer }
    }
}

pub async fn start_recording(
    session_id: &SessionId,
    recordings: &Arc<Mutex<SessionRecordings>>,
    flavor: HttpProxyFlavor,
) -> anyhow::Result<HttpProxyRecorderImpl> {
    let mut recordings = recordings.lock().await;
    recordings
        .start::<HttpProxyRecorderImpl, _>(
            session_id,
            Some("api".into()),
            SessionRecordingMetadata::HttpProxy { flavor },
        )
        .await
        .context("starting recording")
}
