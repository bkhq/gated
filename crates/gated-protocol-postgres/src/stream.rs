use std::fmt::Debug;

use bytes::BytesMut;
use gated_tls::{MaybeTlsStream, MaybeTlsStreamError, UpgradableStream};
use pgwire::error::{PgWireError, PgWireResult};
use pgwire::messages::{PgWireBackendMessage, PgWireFrontendMessage};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tracing::*;

#[derive(thiserror::Error, Debug)]
pub enum PostgresStreamError {
    #[error("decode: {0}")]
    Decode(#[from] PgWireError),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
}

pub(crate) trait PostgresEncode {
    fn encode(&self, buf: &mut BytesMut) -> PgWireResult<()>
    where
        Self: Sized;
}

pub(crate) trait PostgresDecode {
    fn decode(buf: &mut BytesMut) -> PgWireResult<Option<Self>>
    where
        Self: Sized;
}

#[derive(Debug)]
pub(crate) enum PgWireStartupOrSslRequest {
    Startup(pgwire::messages::startup::Startup),
    SslRequest(pgwire::messages::startup::SslRequest),
}

impl PostgresDecode for PgWireStartupOrSslRequest {
    fn decode(buf: &mut BytesMut) -> PgWireResult<Option<Self>> {
        if let Ok(Some(result)) = pgwire::messages::startup::SslRequest::decode(buf) {
            return Ok(Some(Self::SslRequest(result)));
        }
        pgwire::messages::startup::Startup::decode(buf).map(|x| x.map(Self::Startup))
    }
}

#[derive(Debug)]
pub(crate) struct PgWireGenericFrontendMessage(pub PgWireFrontendMessage);

#[derive(Debug)]
pub(crate) struct PgWireGenericBackendMessage(pub PgWireBackendMessage);

impl PostgresDecode for PgWireGenericFrontendMessage {
    fn decode(buf: &mut BytesMut) -> PgWireResult<Option<Self>> {
        PgWireFrontendMessage::decode(buf).map(|x| x.map(PgWireGenericFrontendMessage))
    }
}

impl PostgresDecode for PgWireGenericBackendMessage {
    fn decode(buf: &mut BytesMut) -> PgWireResult<Option<Self>> {
        PgWireBackendMessage::decode(buf).map(|x| x.map(PgWireGenericBackendMessage))
    }
}

impl<T: pgwire::messages::Message> PostgresDecode for T {
    fn decode(buf: &mut BytesMut) -> PgWireResult<Option<Self>> {
        T::decode(buf)
    }
}

impl PostgresEncode for PgWireGenericFrontendMessage {
    fn encode(&self, buf: &mut BytesMut) -> PgWireResult<()> {
        self.0.encode(buf)
    }
}

impl PostgresEncode for PgWireGenericBackendMessage {
    fn encode(&self, buf: &mut BytesMut) -> PgWireResult<()> {
        self.0.encode(buf)
    }
}

impl<T: pgwire::messages::Message> PostgresEncode for T {
    fn encode(&self, buf: &mut BytesMut) -> PgWireResult<()> {
        self.encode(buf)
    }
}

pub(crate) struct PostgresStream<S, TS>
where
    S: UpgradableStream<TS>,
    S: AsyncRead + AsyncWrite + Send + Unpin,
    TS: AsyncRead + AsyncWrite + Unpin,
{
    stream: MaybeTlsStream<S, TS>,
    inbound_buffer: BytesMut,
    outbound_buffer: BytesMut,
}

impl<S, TS> PostgresStream<S, TS>
where
    S: UpgradableStream<TS>,
    S: AsyncRead + AsyncWrite + Send + Unpin,
    TS: AsyncRead + AsyncWrite + Unpin,
{
    pub fn new(stream: S) -> Self {
        Self {
            stream: MaybeTlsStream::new(stream),
            inbound_buffer: BytesMut::new(),
            outbound_buffer: BytesMut::new(),
        }
    }

    pub fn push<M: PostgresEncode + Debug>(
        &mut self,
        message: M,
    ) -> Result<(), PostgresStreamError> {
        trace!(?message, "sending");
        message.encode(&mut self.outbound_buffer)?;
        Ok(())
    }

    pub async fn flush(&mut self) -> std::io::Result<()> {
        self.stream.write_all(&self.outbound_buffer[..]).await?;
        self.outbound_buffer = BytesMut::new();
        self.stream.flush().await?;
        Ok(())
    }

    pub(crate) async fn recv<T: PostgresDecode + Debug>(
        &mut self,
    ) -> Result<Option<T>, PostgresStreamError> {
        loop {
            if let Some(message) = T::decode(&mut self.inbound_buffer)? {
                trace!(?message, "received");
                return Ok(Some(message));
            };

            let read_bytes = self.stream.read_buf(&mut self.inbound_buffer).await?;
            if read_bytes == 0 {
                return Ok(None);
            }
        }
    }

    pub(crate) async fn upgrade(
        mut self,
        config: <S as UpgradableStream<TS>>::UpgradeConfig,
    ) -> Result<Self, MaybeTlsStreamError> {
        self.ensure_nothing_buffered()?;
        self.stream = self.stream.upgrade(config).await?;
        Ok(self)
    }

    /// Bytes that arrived before the TLS handshake were not protected by it
    /// and must not be read as part of the encrypted session.
    fn ensure_nothing_buffered(&self) -> Result<(), MaybeTlsStreamError> {
        if self.inbound_buffer.is_empty() {
            return Ok(());
        }
        Err(MaybeTlsStreamError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unencrypted data received before the TLS handshake",
        )))
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncWriteExt;
    use tokio_rustls::server::TlsStream;

    use super::*;

    const SSL_REQUEST: [u8; 8] = [0, 0, 0, 8, 4, 210, 22, 47];

    #[tokio::test]
    async fn plaintext_behind_the_ssl_request_blocks_the_upgrade() {
        let (mut client, server) = tokio::io::duplex(4096);
        let mut stream = PostgresStream::<_, TlsStream<_>>::new(server);

        let mut injected = SSL_REQUEST.to_vec();
        injected.extend_from_slice(b"Q\0\0\0\x0dSELECT 1\0");
        client.write_all(&injected).await.expect("write");

        let first = stream
            .recv::<PgWireStartupOrSslRequest>()
            .await
            .expect("recv");
        assert!(matches!(
            first,
            Some(PgWireStartupOrSslRequest::SslRequest(_))
        ));
        assert!(stream.ensure_nothing_buffered().is_err());
    }

    #[tokio::test]
    async fn a_lone_ssl_request_allows_the_upgrade() {
        let (mut client, server) = tokio::io::duplex(4096);
        let mut stream = PostgresStream::<_, TlsStream<_>>::new(server);
        client.write_all(&SSL_REQUEST).await.expect("write");

        let first = stream
            .recv::<PgWireStartupOrSslRequest>()
            .await
            .expect("recv");
        assert!(matches!(
            first,
            Some(PgWireStartupOrSslRequest::SslRequest(_))
        ));
        assert!(stream.ensure_nothing_buffered().is_ok());
    }
}
