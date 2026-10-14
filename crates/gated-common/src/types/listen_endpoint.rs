use std::fmt::Debug;
use std::io::ErrorKind;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

use futures::Stream;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpListener, TcpStream};
use tokio_stream::wrappers::TcpListenerStream;

use crate::GatedError;

#[derive(Clone, JsonSchema)]
pub struct ListenEndpoint(SocketAddr);

impl ListenEndpoint {
    pub fn address(&self) -> SocketAddr {
        self.0
    }

    /// Compute the concrete addresses we need to bind, factoring in the
    /// `[::]` IPv6-unspecified case where some kernels need an explicit
    /// IPv4 socket alongside the IPv6 one.
    pub fn addresses_to_listen_on(&self) -> Result<Vec<SocketAddr>, GatedError> {
        if self.0.ip() == Ipv6Addr::UNSPECIFIED {
            Ok(vec![
                SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), self.0.port()),
                SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), self.0.port()),
            ])
        } else {
            Ok(vec![self.0])
        }
    }

    /// Bind every required address with `SO_REUSEADDR` so a previous
    /// instance's `TIME_WAIT` sockets don't block restart. Returns
    /// blocking `std::net::TcpListener`s ready to be promoted to tokio
    /// listeners.
    fn bind_listeners(&self) -> Result<Vec<std::net::TcpListener>, GatedError> {
        if self.0.ip() == Ipv6Addr::UNSPECIFIED {
            // Try v6 first; on dual-stack kernels (default Linux,
            // `IPV6_V6ONLY=0`) it also covers v4 traffic, in which case
            // the subsequent v4 bind raises `AddrInUse` and we drop it.
            // On v6-only kernels we keep both.
            let v6 = bind_one(SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), self.0.port()))?;
            match bind_one(SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), self.0.port())) {
                Ok(v4) => Ok(vec![v4, v6]),
                Err(GatedError::Io(e)) if e.kind() == ErrorKind::AddrInUse => Ok(vec![v6]),
                Err(e) => Err(e),
            }
        } else {
            Ok(vec![bind_one(self.0)?])
        }
    }

    pub async fn tcp_listeners(&self) -> Result<Vec<TcpListener>, GatedError> {
        self.bind_listeners()?
            .into_iter()
            .map(|l| TcpListener::from_std(l).map_err(GatedError::Io))
            .collect()
    }

    pub async fn tcp_accept_stream(
        &self,
    ) -> Result<impl Stream<Item = std::io::Result<TcpStream>> + use<>, GatedError> {
        use futures::stream::{StreamExt, iter};
        Ok(iter(
            self.tcp_listeners()
                .await?
                .into_iter()
                .map(TcpListenerStream::new),
        )
        .flatten_unordered(None))
    }

    pub fn port(&self) -> u16 {
        self.0.port()
    }
}

fn bind_one(addr: SocketAddr) -> Result<std::net::TcpListener, GatedError> {
    let domain = if addr.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    let listener: std::net::TcpListener = socket.into();
    listener.set_nonblocking(true)?;
    Ok(listener)
}

impl From<SocketAddr> for ListenEndpoint {
    fn from(addr: SocketAddr) -> Self {
        Self(addr)
    }
}

impl<'de> Deserialize<'de> for ListenEndpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let v: String = Deserialize::deserialize::<D>(deserializer)?;
        let v = v
            .to_socket_addrs()
            .map_err(|e| {
                serde::de::Error::custom(format!(
                    "failed to resolve {v} into a TCP endpoint: {e:?}"
                ))
            })?
            .next()
            .ok_or_else(|| {
                serde::de::Error::custom(format!("failed to resolve {v} into a TCP endpoint"))
            })?;
        Ok(Self(v))
    }
}

impl Serialize for ListenEndpoint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl Debug for ListenEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
