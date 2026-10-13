use bytes::{Bytes, BytesMut};
use gated_database_protocols::io::Encode;
use gated_tls::{MaybeTlsStream, MaybeTlsStreamError, UpgradableStream};
use mysql_common::proto::codec::error::PacketCodecError;
use mysql_common::proto::codec::PacketCodec;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tracing::*;

#[derive(thiserror::Error, Debug)]
pub enum MySqlStreamError {
    #[error("packet codec error: {0}")]
    Codec(#[from] PacketCodecError),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
}

pub struct MySqlStream<S, TS>
where
    S: UpgradableStream<TS>,
    S: AsyncRead + AsyncWrite + Unpin,
    TS: AsyncRead + AsyncWrite + Unpin,
{
    stream: MaybeTlsStream<S, TS>,
    codec: PacketCodec,
    inbound_buffer: BytesMut,
    outbound_buffer: BytesMut,
}

impl<S, TS> MySqlStream<S, TS>
where
    S: UpgradableStream<TS>,
    S: AsyncRead + AsyncWrite + Unpin,
    TS: AsyncRead + AsyncWrite + Unpin,
{
    pub fn new(stream: S) -> Self {
        Self {
            stream: MaybeTlsStream::new(stream),
            codec: PacketCodec::default(),
            inbound_buffer: BytesMut::new(),
            outbound_buffer: BytesMut::new(),
        }
    }

    pub fn push<'a, C, P: Encode<'a, C>>(
        &mut self,
        packet: &'a P,
        context: C,
    ) -> Result<(), MySqlStreamError> {
        let mut buf = vec![];
        packet.encode_with(&mut buf, context);
        self.codec.encode(&mut &*buf, &mut self.outbound_buffer)?;
        Ok(())
    }

    pub async fn flush(&mut self) -> std::io::Result<()> {
        trace!(outbound_buffer=?self.outbound_buffer, "sending");
        self.stream.write_all(&self.outbound_buffer[..]).await?;
        self.outbound_buffer = BytesMut::new();
        self.stream.flush().await?;
        Ok(())
    }

    pub async fn recv(&mut self) -> Result<Option<Bytes>, MySqlStreamError> {
        let mut payload = BytesMut::new();
        loop {
            {
                let got_full_packet = self.codec.decode(&mut self.inbound_buffer, &mut payload)?;
                if got_full_packet {
                    trace!(?payload, "received");
                    return Ok(Some(payload.freeze()));
                }
            }
            // Before the TLS upgrade the very next bytes on the wire belong to
            // the TLS handshake, and anything read past the current packet is
            // lost when the socket is handed to rustls (~half of the `--ssl`
            // connections failed with "corrupt message"). Read plaintext
            // packets exactly, and only buffer greedily once TLS is up.
            let read_bytes = if self.is_tls() {
                self.stream.read_buf(&mut self.inbound_buffer).await?
            } else {
                self.read_one_packet().await?
            };
            if read_bytes == 0 {
                return Ok(None);
            }
            trace!(inbound_buffer=?self.inbound_buffer, "received chunk");
        }
    }

    /// Read exactly one MySQL wire packet (4-byte header + payload) into the
    /// inbound buffer, consuming nothing beyond it. Returns the number of
    /// bytes read, or 0 on a clean EOF.
    async fn read_one_packet(&mut self) -> Result<usize, MySqlStreamError> {
        let mut header = [0u8; 4];
        if let Err(error) = self.stream.read_exact(&mut header).await {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                return Ok(0);
            }
            return Err(error.into());
        }
        let payload_len = u32::from_le_bytes([header[0], header[1], header[2], 0]) as usize;
        self.inbound_buffer.extend_from_slice(&header);
        let payload_start = self.inbound_buffer.len();
        self.inbound_buffer.resize(payload_start + payload_len, 0);
        self.stream
            .read_exact(
                self.inbound_buffer
                    .get_mut(payload_start..)
                    .ok_or_else(|| std::io::Error::other("Invalid packet payload range"))?,
            )
            .await?;
        Ok(header.len() + payload_len)
    }

    pub fn reset_sequence_id(&mut self) {
        self.codec.reset_seq_id();
    }

    pub async fn upgrade(
        mut self,
        config: <S as UpgradableStream<TS>>::UpgradeConfig,
    ) -> Result<Self, MaybeTlsStreamError> {
        self.stream = self.stream.upgrade(config).await?;
        Ok(self)
    }

    pub fn is_tls(&self) -> bool {
        match self.stream {
            MaybeTlsStream::Raw(_) => false,
            MaybeTlsStream::Tls(_) => true,
            MaybeTlsStream::Upgrading => false,
        }
    }
}
