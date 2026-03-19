use gated_common::ProtocolName;

pub mod proxy;
pub mod recording;
pub mod session_handle;

pub use proxy::create_authenticated_client;
pub use recording::start_recording_api;

pub static PROTOCOL_NAME: ProtocolName = "Api";
