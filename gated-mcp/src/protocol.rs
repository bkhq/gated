use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON-RPC 2.0 message — can be a request (has `method`), a notification
/// (has `method` but no `id`), or a response (has `result`/`error`).
/// We only parse the request/notification shape; responses from the client are
/// currently ignored.
#[derive(Debug, Deserialize)]
pub struct JsonRpcMessage {
    #[allow(dead_code)]
    pub jsonrpc: String,
    /// Present on requests; absent on notifications.
    pub id: Option<Value>,
    /// Present on requests and notifications.
    pub method: Option<String>,
    pub params: Option<Value>,
}

impl JsonRpcMessage {
    /// A message is a *notification* when it has a method but no id.
    pub fn is_notification(&self) -> bool {
        self.method.is_some() && self.id.is_none()
    }

    /// A message is a *request* when it has both a method and an id.
    pub fn is_request(&self) -> bool {
        self.method.is_some() && self.id.is_some()
    }
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<Value>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<Value>, error: JsonRpcError) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}
