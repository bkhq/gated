use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use gated_core::recordings::{AsciiCast, SessionRecordings, TerminalRecordingItem};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::Recording::{self, RecordingKind};
use gated_protocol_http::recording::{HttpProxyRecordingItem, HttpProxyRecordingItemApiObject};
use poem::error::{InternalServerError, NotFoundError};
use poem::web::websocket::{Message, WebSocket};
use poem::web::Data;
use poem::{handler, IntoResponse};
use poem_openapi::param::Path;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, OpenApi};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::json;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;

use super::AnySecurityScheme;

pub struct Api;

#[derive(ApiResponse)]
enum GetRecordingResponse {
    #[oai(status = 200)]
    Ok(Json<Recording::Model>),
    #[oai(status = 404)]
    NotFound,
}

#[derive(ApiResponse)]
enum GetHttpProxyRecordingResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<HttpProxyRecordingItemApiObject>>),
}
#[OpenApi]
impl Api {
    #[oai(
        path = "/recordings/:id",
        method = "get",
        operation_id = "get_recording"
    )]
    async fn api_get_recording(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> poem::Result<GetRecordingResponse> {
        let db = gated_core::db_required(&db).await?;

        let recording = Recording::Entity::find_by_id(id.0)
            .one(&db)
            .await
            .map_err(InternalServerError)?;

        match recording {
            Some(recording) => Ok(GetRecordingResponse::Ok(Json(recording))),
            None => Ok(GetRecordingResponse::NotFound),
        }
    }

    #[oai(
        path = "/recordings/:id/http-proxy",
        method = "get",
        operation_id = "get_http_proxy_recording"
    )]
    async fn api_get_recording_http_proxy(
        &self,
        db: Data<&SharedDatabaseConnection>,
        recordings: Data<&Arc<Mutex<SessionRecordings>>>,
        id: Path<Uuid>,
    ) -> poem::Result<GetHttpProxyRecordingResponse> {
        let db = gated_core::db_required(&db).await?;

        let recording = Recording::Entity::find_by_id(id.0)
            .filter(Recording::Column::Kind.eq(RecordingKind::HttpProxy))
            .one(&db)
            .await
            .map_err(InternalServerError)?;

        let Some(recording) = recording else {
            return Err(NotFoundError.into());
        };

        let path = {
            recordings
                .lock()
                .await
                .path_for(&recording.session_id, &recording.name)
        };

        let file = File::open(&path).await.map_err(InternalServerError)?;
        let reader = BufReader::new(file);
        let mut lines = reader.lines();
        let mut content = Vec::new();

        while let Some(line) = lines.next_line().await.context("reading recording")? {
            let item: HttpProxyRecordingItem =
                serde_json::from_str(&line).context("deserializing recording item")?;
            content.push(HttpProxyRecordingItemApiObject::from(item));
        }

        Ok(GetHttpProxyRecordingResponse::Ok(Json(content)))
    }
}

#[handler]
pub async fn api_get_recording_cast(
    db: Data<&SharedDatabaseConnection>,
    recordings: Data<&Arc<Mutex<SessionRecordings>>>,
    id: poem::web::Path<Uuid>,
) -> poem::Result<String> {
    let db = gated_core::db_required(&db).await?;

    let recording = Recording::Entity::find_by_id(id.0)
        .filter(Recording::Column::Kind.eq(RecordingKind::Terminal))
        .one(&db)
        .await
        .map_err(InternalServerError)?;

    let Some(recording) = recording else {
        return Err(NotFoundError.into());
    };

    let path = {
        recordings
            .lock()
            .await
            .path_for(&recording.session_id, &recording.name)
    };

    let mut response = vec![]; //String::new();

    let mut last_size = (0, 0);
    let file = File::open(&path).await.map_err(InternalServerError)?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();
    while let Some(line) = lines.next_line().await.map_err(InternalServerError)? {
        let entry: TerminalRecordingItem =
            serde_json::from_str(&line[..]).map_err(InternalServerError)?;
        let asciicast: AsciiCast = entry.into();
        response.push(serde_json::to_string(&asciicast).map_err(InternalServerError)?);
        if let AsciiCast::Header { width, height, .. } = asciicast {
            last_size = (width, height);
        }
    }

    response.insert(
        0,
        serde_json::to_string(&AsciiCast::Header {
            time: 0.0,
            version: 2,
            width: last_size.0,
            height: last_size.1,
            title: recording.name,
        })
        .map_err(InternalServerError)?,
    );

    Ok(response.join("\n"))
}

#[handler]
pub async fn api_get_recording_tcpdump(
    db: Data<&SharedDatabaseConnection>,
    recordings: Data<&Arc<Mutex<SessionRecordings>>>,
    id: poem::web::Path<Uuid>,
) -> poem::Result<Bytes> {
    let db = gated_core::db_required(&db).await?;

    let recording = Recording::Entity::find_by_id(id.0)
        .filter(Recording::Column::Kind.eq(RecordingKind::Traffic))
        .one(&db)
        .await
        .map_err(InternalServerError)?;

    let Some(recording) = recording else {
        return Err(NotFoundError.into());
    };

    let path = {
        recordings
            .lock()
            .await
            .path_for(&recording.session_id, &recording.name)
    };

    let content = std::fs::read(path).map_err(InternalServerError)?;

    Ok(Bytes::from(content))
}

#[handler]
pub async fn api_get_recording_stream(
    ws: WebSocket,
    recordings: Data<&Arc<Mutex<SessionRecordings>>>,
    id: poem::web::Path<Uuid>,
) -> impl IntoResponse {
    let recordings = recordings.lock().await;
    let receiver = recordings.subscribe_live(&id).await;

    ws.on_upgrade(|socket| async move {
        let (mut sink, _) = socket.split();

        sink.send(Message::Text(serde_json::to_string(&json!({
            "start": true,
            "live": receiver.is_some(),
        }))?))
        .await?;

        if let Some(mut receiver) = receiver {
            tokio::spawn(async move {
                if let Err(error) = async {
                    while let Ok(data) = receiver.recv().await {
                        let content: TerminalRecordingItem = serde_json::from_slice(&data)?;
                        let cast: AsciiCast = content.into();
                        let msg = serde_json::to_string(&json!({ "data": cast }))?;
                        sink.send(Message::Text(msg)).await?;
                    }
                    sink.send(Message::Text(serde_json::to_string(&json!({
                        "end": true,
                    }))?))
                    .await?;
                    Ok::<(), anyhow::Error>(())
                }
                .await
                {
                    error!(%error, "Livestream error:");
                }
            });
        }

        Ok::<(), anyhow::Error>(())
    })
}
