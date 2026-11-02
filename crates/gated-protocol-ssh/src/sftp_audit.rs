//! Reconstructs file operations from a pass-through SFTP (v3) subsystem stream.
//!
//! The gateway does not terminate SFTP; it only observes the client->target
//! requests and the target->client replies on the subsystem channel and pairs
//! them by request id. Directory listings and attribute reads are not reported.

use std::collections::HashMap;

use bytes::{Buf, Bytes, BytesMut};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SftpFileOperation {
    /// "read" | "write" | "remove" | "rename" | "mkdir" | "rmdir" | "symlink" | "setstat".
    pub operation: &'static str,
    pub path: String,
    pub new_path: Option<String>,
    /// Bytes transferred, for "read" and "write".
    pub bytes: Option<u64>,
    pub success: bool,
    pub error: Option<String>,
}

const SSH_FXP_OPEN: u8 = 3;
const SSH_FXP_CLOSE: u8 = 4;
const SSH_FXP_READ: u8 = 5;
const SSH_FXP_WRITE: u8 = 6;
const SSH_FXP_SETSTAT: u8 = 9;
const SSH_FXP_FSETSTAT: u8 = 10;
const SSH_FXP_REMOVE: u8 = 13;
const SSH_FXP_MKDIR: u8 = 14;
const SSH_FXP_RMDIR: u8 = 15;
const SSH_FXP_RENAME: u8 = 18;
const SSH_FXP_SYMLINK: u8 = 20;
const SSH_FXP_STATUS: u8 = 101;
const SSH_FXP_HANDLE: u8 = 102;
const SSH_FXP_DATA: u8 = 103;
const SSH_FXP_EXTENDED: u8 = 200;

const SSH_FXF_WRITE: u32 = 0x02;
const SSH_FXF_APPEND: u32 = 0x04;
const SSH_FXF_CREAT: u32 = 0x08;
const SSH_FXF_TRUNC: u32 = 0x10;

/// Larger packets than this stop the auditor rather than buffering them.
const MAX_PACKET_LEN: usize = 4 * 1024 * 1024;

const UNCLOSED_FILE_ERROR: &str = "channel closed before the file was closed";

#[derive(Debug)]
struct OpenFile {
    path: String,
    write: bool,
    bytes: u64,
}

#[derive(Debug)]
enum Pending {
    Open {
        path: String,
        write: bool,
    },
    Read {
        handle: Bytes,
    },
    Write {
        handle: Bytes,
        len: u64,
    },
    Close {
        handle: Bytes,
    },
    Path {
        operation: &'static str,
        path: String,
        new_path: Option<String>,
    },
}

#[derive(Default)]
struct Framer {
    buffer: BytesMut,
}

impl Framer {
    /// Appends `data` and returns complete packet payloads, or `None` on an oversized packet.
    fn push(&mut self, data: &[u8]) -> Option<Vec<Bytes>> {
        self.buffer.extend_from_slice(data);
        let mut packets = Vec::new();
        while let Some(prefix) = self.buffer.first_chunk::<4>() {
            let len = u32::from_be_bytes(*prefix) as usize;
            if len > MAX_PACKET_LEN {
                return None;
            }
            if self.buffer.len() < 4 + len {
                break;
            }
            self.buffer.advance(4);
            packets.push(self.buffer.split_to(len).freeze());
        }
        Some(packets)
    }
}

fn read_u32(buf: &mut Bytes) -> Option<u32> {
    (buf.remaining() >= 4).then(|| buf.get_u32())
}

fn read_string(buf: &mut Bytes) -> Option<Bytes> {
    let len = read_u32(buf)? as usize;
    (buf.remaining() >= len).then(|| buf.split_to(len))
}

fn read_path(buf: &mut Bytes) -> Option<String> {
    read_string(buf).map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[derive(Default)]
pub struct SftpAuditor {
    client: Framer,
    server: Framer,
    pending: HashMap<u32, Pending>,
    files: HashMap<Bytes, OpenFile>,
    disabled: bool,
}

impl SftpAuditor {
    pub fn new() -> Self {
        Self::default()
    }

    /// True once a malformed or oversized packet stopped the audit.
    pub fn is_disabled(&self) -> bool {
        self.disabled
    }

    /// Feed client->target bytes.
    pub fn client_data(&mut self, data: &[u8]) -> Vec<SftpFileOperation> {
        if self.disabled {
            return Vec::new();
        }
        match self.client.push(data) {
            Some(packets) => {
                for packet in packets {
                    self.request(packet);
                }
            }
            None => self.disable(),
        }
        Vec::new()
    }

    /// Feed target->client bytes.
    pub fn server_data(&mut self, data: &[u8]) -> Vec<SftpFileOperation> {
        if self.disabled {
            return Vec::new();
        }
        let Some(packets) = self.server.push(data) else {
            self.disable();
            return Vec::new();
        };
        packets
            .into_iter()
            .filter_map(|packet| self.reply(packet))
            .collect()
    }

    /// Report files still open when the channel ends.
    pub fn finish(&mut self) -> Vec<SftpFileOperation> {
        self.pending.clear();
        self.files
            .drain()
            .map(|(_, file)| file_operation(file, Some(UNCLOSED_FILE_ERROR.to_string())))
            .collect()
    }

    fn disable(&mut self) {
        self.disabled = true;
        self.client = Framer::default();
        self.server = Framer::default();
        self.pending.clear();
        self.files.clear();
    }

    fn request(&mut self, mut packet: Bytes) {
        if packet.remaining() < 5 {
            return;
        }
        let kind = packet.get_u8();
        let id = packet.get_u32();
        let pending = match kind {
            SSH_FXP_OPEN => open_request(&mut packet),
            SSH_FXP_READ => read_string(&mut packet).map(|handle| Pending::Read { handle }),
            SSH_FXP_WRITE => write_request(&mut packet),
            SSH_FXP_CLOSE => read_string(&mut packet).map(|handle| Pending::Close { handle }),
            SSH_FXP_REMOVE => path_op("remove", &mut packet, false),
            SSH_FXP_MKDIR => path_op("mkdir", &mut packet, false),
            SSH_FXP_RMDIR => path_op("rmdir", &mut packet, false),
            SSH_FXP_SETSTAT => path_op("setstat", &mut packet, false),
            SSH_FXP_RENAME => path_op("rename", &mut packet, true),
            SSH_FXP_SYMLINK => path_op("symlink", &mut packet, true),
            SSH_FXP_FSETSTAT => read_string(&mut packet).and_then(|handle| {
                let path = self.files.get(&handle)?.path.clone();
                Some(Pending::Path {
                    operation: "setstat",
                    path,
                    new_path: None,
                })
            }),
            SSH_FXP_EXTENDED => read_string(&mut packet).and_then(|name| {
                (name.as_ref() == b"posix-rename@openssh.com")
                    .then(|| path_op("rename", &mut packet, true))
                    .flatten()
            }),
            _ => None,
        };
        if let Some(pending) = pending {
            self.pending.insert(id, pending);
        }
    }

    fn reply(&mut self, mut packet: Bytes) -> Option<SftpFileOperation> {
        if packet.remaining() < 5 {
            return None;
        }
        let kind = packet.get_u8();
        let id = packet.get_u32();
        let pending = self.pending.remove(&id)?;
        let status = (kind == SSH_FXP_STATUS)
            .then(|| {
                let code = read_u32(&mut packet)?;
                let message = read_path(&mut packet).unwrap_or_default();
                Some((code, message))
            })
            .flatten();
        let error = match &status {
            Some((0, _)) | None => None,
            Some((code, message)) if message.is_empty() => Some(format!("status {code}")),
            Some((_, message)) => Some(message.clone()),
        };
        match pending {
            Pending::Open { path, write } => {
                if kind == SSH_FXP_HANDLE {
                    let handle = read_string(&mut packet)?;
                    self.files.insert(
                        handle,
                        OpenFile {
                            path,
                            write,
                            bytes: 0,
                        },
                    );
                    None
                } else {
                    let file = OpenFile {
                        path,
                        write,
                        bytes: 0,
                    };
                    Some(file_operation(file, error.or(Some("open failed".into()))))
                }
            }
            Pending::Read { handle } => {
                if kind == SSH_FXP_DATA
                    && let Some(data) = read_string(&mut packet)
                    && let Some(file) = self.files.get_mut(&handle)
                {
                    file.bytes += data.len() as u64;
                }
                None
            }
            Pending::Write { handle, len } => {
                if error.is_none()
                    && let Some(file) = self.files.get_mut(&handle)
                {
                    file.bytes += len;
                }
                None
            }
            Pending::Close { handle } => {
                let file = self.files.remove(&handle)?;
                Some(file_operation(file, error))
            }
            Pending::Path {
                operation,
                path,
                new_path,
            } => {
                status?;
                Some(SftpFileOperation {
                    operation,
                    path,
                    new_path,
                    bytes: None,
                    success: error.is_none(),
                    error,
                })
            }
        }
    }
}

fn open_request(packet: &mut Bytes) -> Option<Pending> {
    let path = read_path(packet)?;
    let pflags = read_u32(packet)?;
    let write = pflags & (SSH_FXF_WRITE | SSH_FXF_APPEND | SSH_FXF_CREAT | SSH_FXF_TRUNC) != 0;
    Some(Pending::Open { path, write })
}

fn write_request(packet: &mut Bytes) -> Option<Pending> {
    let handle = read_string(packet)?;
    if packet.remaining() < 8 {
        return None;
    }
    packet.advance(8);
    let len = u64::from(read_u32(packet)?);
    Some(Pending::Write { handle, len })
}

fn path_op(operation: &'static str, packet: &mut Bytes, two_paths: bool) -> Option<Pending> {
    let path = read_path(packet)?;
    let new_path = if two_paths {
        Some(read_path(packet)?)
    } else {
        None
    };
    Some(Pending::Path {
        operation,
        path,
        new_path,
    })
}

fn file_operation(file: OpenFile, error: Option<String>) -> SftpFileOperation {
    SftpFileOperation {
        operation: if file.write { "write" } else { "read" },
        path: file.path,
        new_path: None,
        bytes: Some(file.bytes),
        success: error.is_none(),
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string(out: &mut Vec<u8>, value: &[u8]) {
        out.extend_from_slice(&(value.len() as u32).to_be_bytes());
        out.extend_from_slice(value);
    }

    fn packet(kind: u8, id: Option<u32>, body: &[u8]) -> Vec<u8> {
        let mut payload = vec![kind];
        if let Some(id) = id {
            payload.extend_from_slice(&id.to_be_bytes());
        }
        payload.extend_from_slice(body);
        let mut out = (payload.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&payload);
        out
    }

    fn open(id: u32, path: &str, pflags: u32) -> Vec<u8> {
        let mut body = Vec::new();
        string(&mut body, path.as_bytes());
        body.extend_from_slice(&pflags.to_be_bytes());
        body.extend_from_slice(&0u32.to_be_bytes()); // attrs flags
        packet(3, Some(id), &body)
    }

    fn handle_reply(id: u32, handle: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        string(&mut body, handle);
        packet(102, Some(id), &body)
    }

    fn status(id: u32, code: u32, message: &str) -> Vec<u8> {
        let mut body = code.to_be_bytes().to_vec();
        string(&mut body, message.as_bytes());
        string(&mut body, b"en");
        packet(101, Some(id), &body)
    }

    fn with_handle(kind: u8, id: u32, handle: &[u8], rest: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        string(&mut body, handle);
        body.extend_from_slice(rest);
        packet(kind, Some(id), &body)
    }

    fn read(id: u32, handle: &[u8], len: u32) -> Vec<u8> {
        let mut rest = 0u64.to_be_bytes().to_vec();
        rest.extend_from_slice(&len.to_be_bytes());
        with_handle(5, id, handle, &rest)
    }

    fn write(id: u32, handle: &[u8], data: &[u8]) -> Vec<u8> {
        let mut rest = 0u64.to_be_bytes().to_vec();
        string(&mut rest, data);
        with_handle(6, id, handle, &rest)
    }

    fn data_reply(id: u32, data: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        string(&mut body, data);
        packet(103, Some(id), &body)
    }

    fn path_request(kind: u8, id: u32, paths: &[&str]) -> Vec<u8> {
        let mut body = Vec::new();
        for path in paths {
            string(&mut body, path.as_bytes());
        }
        if kind == 14 {
            body.extend_from_slice(&0u32.to_be_bytes()); // mkdir attrs
        }
        packet(kind, Some(id), &body)
    }

    fn op(
        operation: &'static str,
        path: &str,
        bytes: Option<u64>,
        success: bool,
    ) -> SftpFileOperation {
        SftpFileOperation {
            operation,
            path: path.into(),
            new_path: None,
            bytes,
            success,
            error: None,
        }
    }

    #[test]
    fn download_reports_one_read_with_bytes() {
        let mut a = SftpAuditor::new();
        assert!(
            a.client_data(&packet(1, None, &3u32.to_be_bytes()))
                .is_empty()
        );
        assert!(a.client_data(&open(1, "/etc/hosts", 0x01)).is_empty());
        assert!(a.server_data(&handle_reply(1, b"h1")).is_empty());
        a.client_data(&read(2, b"h1", 32768));
        a.server_data(&data_reply(2, &[7; 100]));
        a.client_data(&read(3, b"h1", 32768));
        a.server_data(&data_reply(3, &[7; 20]));
        a.client_data(&with_handle(4, 4, b"h1", &[]));
        let ops = a.server_data(&status(4, 0, "OK"));
        assert_eq!(ops, vec![op("read", "/etc/hosts", Some(120), true)]);
    }

    #[test]
    fn upload_split_across_chunks_reports_one_write() {
        let mut a = SftpAuditor::new();
        let mut stream = open(1, "/tmp/up.bin", 0x02 | 0x08 | 0x10);
        stream.extend(write(2, b"h", &[1; 50]));
        stream.extend(write(3, b"h", &[1; 30]));
        stream.extend(with_handle(4, 4, b"h", &[]));
        let (first, second) = stream.split_at(7);
        a.client_data(first);
        a.client_data(second);
        let mut replies = handle_reply(1, b"h");
        replies.extend(status(2, 0, ""));
        replies.extend(status(3, 0, ""));
        replies.extend(status(4, 0, ""));
        let mut ops = Vec::new();
        for byte in replies {
            ops.extend(a.server_data(&[byte]));
        }
        assert_eq!(ops, vec![op("write", "/tmp/up.bin", Some(80), true)]);
    }

    #[test]
    fn failed_open_is_reported_with_the_error() {
        let mut a = SftpAuditor::new();
        a.client_data(&open(1, "/root/secret", 0x01));
        let ops = a.server_data(&status(1, 3, "Permission denied"));
        assert_eq!(
            ops,
            vec![SftpFileOperation {
                error: Some("Permission denied".into()),
                ..op("read", "/root/secret", Some(0), false)
            }]
        );
    }

    #[test]
    fn path_operations_are_reported_on_status() {
        let mut a = SftpAuditor::new();
        a.client_data(&path_request(13, 1, &["/tmp/a"]));
        a.client_data(&path_request(14, 2, &["/tmp/d"]));
        a.client_data(&path_request(15, 3, &["/tmp/d"]));
        a.client_data(&path_request(18, 4, &["/tmp/b", "/tmp/c"]));
        a.client_data(&path_request(17, 5, &["/tmp/c"])); // STAT: not reported
        let mut ops = a.server_data(&status(1, 0, ""));
        ops.extend(a.server_data(&status(2, 0, "")));
        ops.extend(a.server_data(&status(3, 4, "Failure")));
        ops.extend(a.server_data(&status(4, 0, "")));
        ops.extend(a.server_data(&status(5, 0, "")));
        assert_eq!(
            ops,
            vec![
                op("remove", "/tmp/a", None, true),
                op("mkdir", "/tmp/d", None, true),
                SftpFileOperation {
                    error: Some("Failure".into()),
                    ..op("rmdir", "/tmp/d", None, false)
                },
                SftpFileOperation {
                    new_path: Some("/tmp/c".into()),
                    ..op("rename", "/tmp/b", None, true)
                },
            ]
        );
    }

    #[test]
    fn posix_rename_extension_is_a_rename() {
        let mut a = SftpAuditor::new();
        let mut body = Vec::new();
        string(&mut body, b"posix-rename@openssh.com");
        string(&mut body, b"/x");
        string(&mut body, b"/y");
        a.client_data(&packet(200, Some(9), &body));
        let ops = a.server_data(&status(9, 0, ""));
        assert_eq!(
            ops,
            vec![SftpFileOperation {
                new_path: Some("/y".into()),
                ..op("rename", "/x", None, true)
            }]
        );
    }

    #[test]
    fn open_files_are_reported_when_the_channel_ends() {
        let mut a = SftpAuditor::new();
        a.client_data(&open(1, "/var/log/big", 0x01));
        a.server_data(&handle_reply(1, b"h"));
        a.client_data(&read(2, b"h", 10));
        a.server_data(&data_reply(2, &[0; 10]));
        assert_eq!(
            a.finish(),
            vec![SftpFileOperation {
                error: Some("channel closed before the file was closed".into()),
                ..op("read", "/var/log/big", Some(10), false)
            }]
        );
    }

    #[test]
    fn oversized_packet_disables_the_auditor() {
        let mut a = SftpAuditor::new();
        a.client_data(&u32::MAX.to_be_bytes());
        a.client_data(&path_request(13, 1, &["/tmp/a"]));
        assert!(a.server_data(&status(1, 0, "")).is_empty());
        assert!(a.is_disabled());
    }
}
