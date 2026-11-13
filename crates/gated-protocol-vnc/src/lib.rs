//! VNC (RFB) client side of the browser desktop bridge. There is no native
//! VNC listener: the gateway connects to the target and hands the session to
//! the bridge as protocol-neutral desktop events and inputs.

mod client;

pub use client::{VncClientOptions, connect};
