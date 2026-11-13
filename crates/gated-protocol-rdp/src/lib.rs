//! RDP client side of the browser desktop bridge. There is no native RDP
//! listener: the gateway connects to the target with IronRDP and hands the
//! session to the bridge as protocol-neutral desktop events and inputs.

mod client;
mod clipboard;
mod input;
mod inspect;
mod tls;

pub use client::{RdpClientOptions, connect};
pub use inspect::inspect_certificate;
