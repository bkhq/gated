#![forbid(unsafe_code)]
use gated_common::ProtocolName;

pub mod engine;
pub mod kubernetes;
pub mod recording;
pub mod resolver;
pub mod server;
pub mod session_handle;

pub use engine::{build_http_client, FlavorHook, HttpProxyRecorder};
pub use recording::start_recording;

pub static PROTOCOL_NAME: ProtocolName = "Http";
