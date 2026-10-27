use std::future::Future;

use anyhow::Result;
use gated_common::ListenEndpoint;

mod handle;

pub use handle::{GatedServerHandle, SessionHandle};

pub trait ProtocolServer {
    fn name(&self) -> &'static str;
    fn run(self, address: ListenEndpoint) -> impl Future<Output = Result<()>> + Send;
}
