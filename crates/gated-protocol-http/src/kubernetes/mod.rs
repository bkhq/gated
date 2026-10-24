use gated_common::ProtocolName;

pub mod auth;
pub mod client_certs;
pub mod correlator;
pub mod recording;
pub mod session_handle;
pub mod websocket;

pub static PROTOCOL_NAME: ProtocolName = "Kubernetes";
