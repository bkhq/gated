use std::future::Future;

use axum::extract::ws::{CloseFrame, Message};
use futures::{Sink, SinkExt, Stream, StreamExt};
use tokio_tungstenite::tungstenite::{self, Utf8Bytes};

pub trait TungsteniteCompatibleWebsocketMessage {
    fn to_tungstenite_message(self) -> tungstenite::Message;
    fn from_tungstenite_message(m: tungstenite::Message) -> Self;
}

impl TungsteniteCompatibleWebsocketMessage for Message {
    fn to_tungstenite_message(self) -> tungstenite::Message {
        match self {
            Message::Binary(data) => tungstenite::Message::Binary(data),
            Message::Text(text) => tungstenite::Message::Text(text.as_str().into()),
            Message::Ping(data) => tungstenite::Message::Ping(data),
            Message::Pong(data) => tungstenite::Message::Pong(data),
            Message::Close(data) => {
                tungstenite::Message::Close(data.map(|data| tungstenite::protocol::CloseFrame {
                    code: data.code.into(),
                    reason: data.reason.as_str().into(),
                }))
            }
        }
    }

    fn from_tungstenite_message(msg: tungstenite::Message) -> Self {
        match msg {
            tungstenite::Message::Binary(data) => Message::Binary(data),
            tungstenite::Message::Text(text) => Message::Text(text.as_str().into()),
            tungstenite::Message::Ping(data) => Message::Ping(data),
            tungstenite::Message::Pong(data) => Message::Pong(data),
            tungstenite::Message::Close(data) => Message::Close(data.map(|data| CloseFrame {
                code: data.code.into(),
                reason: data.reason.as_str().into(),
            })),
            tungstenite::Message::Frame(_) => unreachable!(),
        }
    }
}

impl TungsteniteCompatibleWebsocketMessage for reqwest_websocket::Message {
    fn to_tungstenite_message(self) -> tungstenite::Message {
        match self {
            reqwest_websocket::Message::Binary(data) => tungstenite::Message::Binary(data),
            reqwest_websocket::Message::Text(text) => {
                tungstenite::Message::Text(Utf8Bytes::from(text))
            }
            reqwest_websocket::Message::Ping(data) => tungstenite::Message::Ping(data),
            reqwest_websocket::Message::Pong(data) => tungstenite::Message::Pong(data),
            reqwest_websocket::Message::Close { code, reason } => {
                tungstenite::Message::Close(Some(tungstenite::protocol::CloseFrame {
                    code: u16::from(code).into(),
                    reason: Utf8Bytes::from(reason),
                }))
            }
        }
    }

    fn from_tungstenite_message(msg: tungstenite::Message) -> Self {
        match msg {
            tungstenite::Message::Binary(data) => reqwest_websocket::Message::Binary(data),
            tungstenite::Message::Text(text) => reqwest_websocket::Message::Text(text.to_string()),
            tungstenite::Message::Ping(data) => reqwest_websocket::Message::Ping(data),
            tungstenite::Message::Pong(data) => reqwest_websocket::Message::Pong(data),
            tungstenite::Message::Close(data) => reqwest_websocket::Message::Close {
                code: data
                    .as_ref()
                    .map(|data| u16::from(data.code).into())
                    .unwrap_or(reqwest_websocket::CloseCode::Normal),
                reason: data.map(|data| data.reason.to_string()).unwrap_or_default(),
            },
            tungstenite::Message::Frame(_) => unreachable!(),
        }
    }
}

impl TungsteniteCompatibleWebsocketMessage for tungstenite::Message {
    fn to_tungstenite_message(self) -> tungstenite::Message {
        self
    }

    fn from_tungstenite_message(msg: tungstenite::Message) -> Self {
        msg
    }
}

pub async fn pump_websocket<
    DM: TungsteniteCompatibleWebsocketMessage + Send,
    D: Sink<DM> + Send + Unpin,
    SM: TungsteniteCompatibleWebsocketMessage + Send,
    SE: Send,
    S: Stream<Item = Result<SM, SE>> + Send + Unpin,
    FE: Send,
    F: FnMut(tungstenite::Message) -> Fut,
    Fut: Future<Output = Result<tungstenite::Message, FE>> + Send,
>(
    mut source: S,
    mut sink: D,
    mut callback: F,
) -> anyhow::Result<()>
where
    anyhow::Error: From<D::Error>,
    anyhow::Error: From<SE>,
    anyhow::Error: From<FE>,
{
    while let Some(msg) = source.next().await {
        let msg = msg?.to_tungstenite_message();
        let msg = callback(msg).await?;
        sink.send(DM::from_tungstenite_message(msg)).await?;
    }
    Ok::<_, anyhow::Error>(())
}
