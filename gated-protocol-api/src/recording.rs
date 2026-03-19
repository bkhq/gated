use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use poem_openapi::Object;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use gated_common::SessionId;
use gated_core::recordings::{Recorder, RecordingWriter, SessionRecordings};
use gated_db_entities::Recording::RecordingKind;

#[derive(Debug, Object)]
#[oai(rename = "ApiRecordingItem")]
pub struct ApiRecordingItemApiObject {
    pub timestamp: DateTime<Utc>,
    pub request_method: String,
    pub request_path: String,
    pub request_body: serde_json::Value,
    pub response_status: Option<u16>,
    pub response_body: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ApiRecordingItem {
    pub timestamp: DateTime<Utc>,
    pub request_method: String,
    pub request_path: String,
    pub request_headers: HashMap<String, String>,
    #[serde(with = "gated_common::helpers::serde_base64")]
    pub request_body: Bytes,
    pub response_status: Option<u16>,
    pub response_body: Option<Vec<u8>>,
}

impl From<ApiRecordingItem> for ApiRecordingItemApiObject {
    fn from(item: ApiRecordingItem) -> Self {
        ApiRecordingItemApiObject {
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

pub struct ApiRecorder {
    writer: RecordingWriter,
}

impl ApiRecorder {
    async fn write_item(
        &mut self,
        item: &ApiRecordingItem,
    ) -> Result<(), gated_core::recordings::Error> {
        let mut serialized_item =
            serde_json::to_vec(&item).map_err(gated_core::recordings::Error::Serialization)?;
        serialized_item.push(b'\n');
        self.writer.write(&serialized_item).await?;
        Ok(())
    }

    pub async fn record_response(
        &mut self,
        method: &str,
        path: &str,
        headers: HashMap<String, String>,
        request_body: &[u8],
        status: u16,
        response_body: &[u8],
    ) -> Result<(), gated_core::recordings::Error> {
        self.write_item(&ApiRecordingItem {
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

impl Recorder for ApiRecorder {
    fn kind() -> RecordingKind {
        RecordingKind::Api
    }

    fn new(writer: RecordingWriter) -> Self {
        ApiRecorder { writer }
    }
}

pub async fn start_recording_api(
    session_id: &SessionId,
    recordings: &Arc<Mutex<SessionRecordings>>,
) -> anyhow::Result<ApiRecorder> {
    let mut recordings = recordings.lock().await;
    Ok(recordings
        .start::<ApiRecorder, _>(session_id, Some("api".into()), ())
        .await
        .context("starting recording")?)
}
