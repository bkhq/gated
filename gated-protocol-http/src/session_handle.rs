use std::any::type_name;
use std::sync::Arc;

use poem::error::GetDataError;
use poem::session::Session;
use poem::web::Data;
use poem::{FromRequest, Request, RequestBody};
use tokio::sync::{mpsc, Mutex};
use gated_core::{SessionHandle, GatedServerHandle};

use crate::session::SessionStore;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionHandleCommand {
    Close,
}

pub struct HttpSessionHandle {
    sender: mpsc::UnboundedSender<SessionHandleCommand>,
}

impl HttpSessionHandle {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<SessionHandleCommand>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (HttpSessionHandle { sender }, receiver)
    }
}

impl SessionHandle for HttpSessionHandle {
    fn close(&mut self) {
        let _ = self.sender.send(SessionHandleCommand::Close);
    }
}

#[derive(Clone)]
pub struct GatedServerHandleFromRequest(pub Arc<Mutex<GatedServerHandle>>);

impl std::ops::Deref for GatedServerHandleFromRequest {
    type Target = Arc<Mutex<GatedServerHandle>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<'a> FromRequest<'a> for GatedServerHandleFromRequest {
    async fn from_request(req: &'a Request, _: &mut RequestBody) -> poem::Result<Self> {
        let sm = Data::<&Arc<Mutex<SessionStore>>>::from_request_without_body(req).await?;
        let session = <&Session>::from_request_without_body(req).await?;
        Ok(sm
            .lock()
            .await
            .handle_for(session)
            .map(GatedServerHandleFromRequest)
            .ok_or_else(|| GetDataError(type_name::<GatedServerHandle>()))?)
    }
}

impl From<Arc<Mutex<GatedServerHandle>>> for GatedServerHandleFromRequest {
    fn from(handle: Arc<Mutex<GatedServerHandle>>) -> Self {
        GatedServerHandleFromRequest(handle)
    }
}
