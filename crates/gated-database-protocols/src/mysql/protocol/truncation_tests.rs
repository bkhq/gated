//! Decoders must reject truncated packets with an error instead of panicking.

use bytes::Bytes;

use crate::io::{Decode, Encode};
use crate::mysql::io::MySqlBufExt;
use crate::mysql::protocol::Capabilities;
use crate::mysql::protocol::auth::AuthPlugin;
use crate::mysql::protocol::connect::{AuthSwitchRequest, Handshake, HandshakeResponse};
use crate::mysql::protocol::response::{EofPacket, ErrPacket, OkPacket};
use crate::mysql::protocol::text::{ColumnDefinition, Query};

/// Decodes the full packet and every strict prefix of it. The full packet
/// must decode; the empty prefix must be an error; nothing may panic.
fn check_prefixes<T>(packet: &[u8], decode: impl Fn(Bytes) -> Result<T, crate::error::Error>) {
    assert!(decode(Bytes::copy_from_slice(packet)).is_ok());
    assert!(decode(Bytes::new()).is_err());
    for len in 0..packet.len() {
        let _ = decode(Bytes::copy_from_slice(&packet[..len]));
    }
}

fn handshake_response_packet(capabilities: Capabilities) -> Vec<u8> {
    let mut buf = Vec::new();
    HandshakeResponse {
        database: Some("db".to_owned()),
        max_packet_size: 1024,
        collation: 45,
        username: "root".to_owned(),
        auth_plugin: Some(AuthPlugin::MySqlNativePassword),
        auth_response: Some(Bytes::from_static(&[7; 20])),
    }
    .encode_with(&mut buf, capabilities);
    buf
}

#[test]
fn handshake_response_rejects_truncated_packets() {
    let base = Capabilities::MYSQL
        | Capabilities::PROTOCOL_41
        | Capabilities::CONNECT_WITH_DB
        | Capabilities::PLUGIN_AUTH;
    for capabilities in [
        base,
        base | Capabilities::SECURE_CONNECTION,
        base | Capabilities::PLUGIN_AUTH_LENENC_DATA,
    ] {
        check_prefixes(&handshake_response_packet(capabilities), |buf| {
            HandshakeResponse::decode_with(buf, &mut Capabilities::all())
        });
    }
}

#[test]
fn handshake_response_rejects_oversized_auth_response_length() {
    let mut packet = handshake_response_packet(
        Capabilities::MYSQL | Capabilities::PROTOCOL_41 | Capabilities::PLUGIN_AUTH_LENENC_DATA,
    );
    // 32 fixed bytes + "root\0", then the length-encoded auth response.
    packet.truncate(37);
    packet.extend([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    let result = HandshakeResponse::decode_with(Bytes::from(packet), &mut Capabilities::all());
    assert!(result.is_err());
}

#[test]
fn handshake_rejects_truncated_packets() {
    let mut packet = vec![10];
    packet.extend(b"8.0.0\0");
    packet.extend(1_u32.to_le_bytes());
    packet.extend([1; 8]);
    packet.push(0);
    packet.extend([0xff, 0xff]);
    packet.push(45);
    packet.extend([0, 0]);
    packet.extend([0xff, 0xff]);
    packet.push(21);
    packet.extend([0; 6]);
    packet.extend([0; 4]);
    packet.extend([2; 12]);
    packet.push(0);
    packet.extend(b"mysql_native_password\0");
    check_prefixes(&packet, Handshake::decode);
}

#[test]
fn auth_switch_request_rejects_truncated_packets() {
    let mut packet = vec![0xfe];
    packet.extend(b"mysql_native_password\0");
    packet.extend([3; 20]);
    packet.push(0);
    check_prefixes(&packet, AuthSwitchRequest::decode);
}

#[test]
fn response_packets_reject_truncated_packets() {
    check_prefixes(&[0x00, 1, 2, 2, 0, 0, 0], OkPacket::decode);
    check_prefixes(&[0xfe, 0, 0, 2, 0], |buf| {
        EofPacket::decode_with(buf, Capabilities::PROTOCOL_41)
    });

    let mut err = vec![0xff, 0x28, 0x04, b'#'];
    err.extend(b"42000syntax error");
    check_prefixes(&err, |buf| {
        ErrPacket::decode_with(buf, Capabilities::PROTOCOL_41)
    });
}

#[test]
fn column_definition_rejects_truncated_packets() {
    let mut packet = Vec::new();
    for field in ["def", "schema", "t", "table", "c", "column"] {
        packet.push(field.len() as u8);
        packet.extend(field.as_bytes());
    }
    packet.push(0x0c);
    packet.extend([45, 0]);
    packet.extend(11_u32.to_le_bytes());
    packet.push(0x03);
    packet.extend([0, 0]);
    packet.push(0);
    check_prefixes(&packet, |buf| {
        ColumnDefinition::decode_with(buf, Capabilities::PROTOCOL_41)
    });
}

#[test]
fn query_rejects_empty_packet() {
    check_prefixes(b"\x03select 1", Query::decode);
}

#[test]
fn lenenc_readers_reject_truncated_input() {
    for input in [
        &[][..],
        &[0xfc],
        &[0xfc, 1],
        &[0xfd, 1, 2],
        &[0xfe, 1, 2, 3],
    ] {
        assert!(Bytes::copy_from_slice(input).get_uint_lenenc().is_err());
    }
    assert_eq!(
        Bytes::from_static(&[0xfc, 0x34, 0x12])
            .get_uint_lenenc()
            .ok(),
        Some(0x1234)
    );

    assert!(Bytes::from_static(&[5, b'a']).get_bytes_lenenc().is_err());
    assert_eq!(
        Bytes::from_static(&[2, b'a', b'b', b'c'])
            .get_bytes_lenenc()
            .ok(),
        Some(Bytes::from_static(b"ab"))
    );
}
