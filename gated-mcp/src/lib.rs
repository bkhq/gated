mod auth;
mod protocol;
mod tools;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::*;
use uuid::Uuid;
use gated_core::Services;

use crate::auth::{AuthContext, authenticate};
use crate::protocol::{JsonRpcError, JsonRpcMessage, JsonRpcResponse};
use crate::tools::ToolHandler;

const SESSION_HEADER: &str = "Mcp-Session-Id";

pub struct AppState {
    tool_handler: ToolHandler,
    services: Services,
    sessions: Mutex<HashSet<String>>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub async fn run_mcp_server(services: &Services, bind_addr: SocketAddr) -> Result<()> {
    let state = Arc::new(AppState {
        tool_handler: ToolHandler::new(services),
        services: services.clone(),
        sessions: Mutex::new(HashSet::new()),
    });

    let app = axum::Router::new()
        .route("/mcp", any(handle_mcp))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    info!(%bind_addr, "MCP server listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

async fn handle_mcp(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    match method {
        Method::POST => handle_post(state, headers, body).await,
        Method::DELETE => handle_delete(state, headers).await,
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

// ---------------------------------------------------------------------------
// DELETE — session termination
// ---------------------------------------------------------------------------

async fn handle_delete(state: Arc<AppState>, headers: HeaderMap) -> Response {
    // Require authentication for session termination to prevent
    // unauthenticated attackers from draining the session set.
    if authenticate(&state.services, &headers).await.is_err() {
        return error_response(StatusCode::UNAUTHORIZED, "Authentication required");
    }

    if let Some(sid) = headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()) {
        state.sessions.lock().await.remove(sid);
        debug!(session_id = sid, "MCP session terminated");
    }
    StatusCode::NO_CONTENT.into_response()
}

// ---------------------------------------------------------------------------
// POST — main JSON-RPC handler
// ---------------------------------------------------------------------------

async fn handle_post(state: Arc<AppState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    // Try to parse as a single message or as a batch (array).
    let messages: Vec<JsonRpcMessage> = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Array(arr)) => match serde_json::from_value(Value::Array(arr.clone())) {
            Ok(msgs) => msgs,
            Err(e) => return bad_request(&format!("Invalid batch: {e}")),
        },
        Ok(obj @ Value::Object(_)) => match serde_json::from_value(obj) {
            Ok(msg) => vec![msg],
            Err(e) => return bad_request(&format!("Invalid JSON-RPC message: {e}")),
        },
        Ok(_) => return bad_request("Expected JSON object or array"),
        Err(e) => return bad_request(&format!("Invalid JSON: {e}")),
    };

    if messages.is_empty() {
        return bad_request("Empty batch");
    }

    // Check if the batch contains any *initialize* message.
    let has_initialize = messages
        .iter()
        .any(|m| m.method.as_deref() == Some("initialize"));

    // Session validation: if this is not an initialize request,
    // check that the session ID is valid.
    if !has_initialize {
        match validate_session(&state, &headers).await {
            Ok(()) => {}
            Err(resp) => return resp,
        }
    }

    let has_requests = messages.iter().any(|m| m.is_request());

    let mut responses: Vec<JsonRpcResponse> = Vec::new();
    let mut session_id_to_set: Option<String> = None;

    for msg in &messages {
        // Notifications → no response needed.
        if msg.is_notification() {
            continue;
        }

        // Only requests produce responses.
        if !msg.is_request() {
            continue;
        }

        let method = msg.method.as_deref().unwrap_or("");

        // Initialize and ping do not require auth.
        if method == "initialize" {
            let sid = Uuid::new_v4().to_string();
            state.sessions.lock().await.insert(sid.clone());
            debug!(session_id = %sid, "MCP session created");

            let result = handle_initialize();
            responses.push(match result {
                Ok(v) => JsonRpcResponse::success(msg.id.clone(), v),
                Err(e) => JsonRpcResponse::error(msg.id.clone(), e),
            });
            session_id_to_set = Some(sid);
            continue;
        }

        if method == "ping" {
            responses.push(JsonRpcResponse::success(
                msg.id.clone(),
                serde_json::json!({}),
            ));
            continue;
        }

        if method == "tools/list" {
            responses.push(match handle_tools_list() {
                Ok(v) => JsonRpcResponse::success(msg.id.clone(), v),
                Err(e) => JsonRpcResponse::error(msg.id.clone(), e),
            });
            continue;
        }

        // All other methods require authentication.
        let auth = match authenticate(&state.services, &headers).await {
            Ok(auth) => auth,
            Err(err) => {
                responses.push(JsonRpcResponse::error(msg.id.clone(), err));
                continue;
            }
        };

        let result = match method {
            "tools/call" => handle_tools_call(&state.tool_handler, msg, &auth).await,
            _ => Err(JsonRpcError {
                code: -32601,
                message: format!("Method not found: {method}"),
                data: None,
            }),
        };

        responses.push(match result {
            Ok(v) => JsonRpcResponse::success(msg.id.clone(), v),
            Err(e) => JsonRpcResponse::error(msg.id.clone(), e),
        });
    }

    // If the batch contained only notifications (no requests), return 202.
    if !has_requests {
        return StatusCode::ACCEPTED.into_response();
    }

    // Build the response body: single object or array.
    let body_value = if responses.len() == 1 {
        serde_json::to_vec(&responses.into_iter().next().unwrap())
    } else {
        serde_json::to_vec(&responses)
    };

    let body_bytes = match body_value {
        Ok(b) => b,
        Err(e) => {
            error!(?e, "Failed to serialize response");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json");

    if let Some(sid) = session_id_to_set {
        builder = builder.header(SESSION_HEADER, sid);
    }

    builder
        .body(Body::from(body_bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------

async fn validate_session(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let sessions = state.sessions.lock().await;

    let sid = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            error_response(
                StatusCode::BAD_REQUEST,
                "Missing Mcp-Session-Id header",
            )
        })?;

    if !sessions.contains(sid) {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "Unknown or expired session",
        ));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// JSON-RPC handlers
// ---------------------------------------------------------------------------

fn handle_initialize() -> Result<Value, JsonRpcError> {
    Ok(serde_json::json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {
                "listChanged": false
            }
        },
        "serverInfo": {
            "name": "gated-mcp",
            "version": env!("CARGO_PKG_VERSION")
        }
    }))
}

fn handle_tools_list() -> Result<Value, JsonRpcError> {
    Ok(serde_json::json!({
        "tools": tools::tool_definitions()
    }))
}

async fn handle_tools_call(
    handler: &ToolHandler,
    msg: &JsonRpcMessage,
    auth: &AuthContext,
) -> Result<Value, JsonRpcError> {
    let params = msg.params.as_ref().ok_or(JsonRpcError {
        code: -32602,
        message: "Missing params".into(),
        data: None,
    })?;

    let tool_name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or(JsonRpcError {
            code: -32602,
            message: "Missing tool name".into(),
            data: None,
        })?;

    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    handler.call(tool_name, arguments, auth).await
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn bad_request(msg: &str) -> Response {
    error_response(StatusCode::BAD_REQUEST, msg)
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    let body = serde_json::json!({ "error": msg });
    (
        status,
        [(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        )],
        serde_json::to_string(&body).unwrap_or_default(),
    )
        .into_response()
}
