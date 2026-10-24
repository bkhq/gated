# 20261021-0228-web-sftp-file-manager Add an audited SFTP file manager to the web UI

- **status**: completed
- **createdAt**: 2026-10-21 02:28
- **approvedAt**: 2026-10-21 02:40
- **relatedTask**: 20261021-0228-web-sftp-file-manager

## Context

- Native SSH listener: SFTP already works as a pass-through subsystem (`ChannelOperation::RequestSubsystem`, `server/session.rs` `_channel_subsystem_request`; covered by `tests/ssh/proto.test.ts` "sftp"). The subsystem channel is not recorded: `TerminalRecorder` covers shell/exec channels and `TrafficRecorder` covers forwards, so file transfers through the gateway leave no audit trail and command ACLs do not apply.
- Web terminal (`gated-admin/src/http_service/api/ssh_terminal.rs`): resolves and authorizes the target (`resolve_and_authorize`, role assignments and account binding), registers a session in `State`, drives a `RemoteClient` (`gated-protocol-ssh/src/client`) through `RCCommand`/`RCEvent`; channel output arrives as `RCEvent::Output(channel, Bytes)`.
- Structured audit recordings already exist for SQL (`RecordingKind::SqlAudit`, `gated-core/src/recordings/structured.rs`, JSON lines) and commands (`CommandAudit`). `recordings.kind` is `String(16)`, so a new `file_audit` value needs no migration.
- No file transfer permission exists on roles or targets; access is target role assignment only.
- Library: `russh-sftp` 3.0.1 (crates.io, updated 2026-09-28) implements the SFTP v3 client over any `AsyncRead + AsyncWrite` stream and depends on `russh ^0.63` only as a dev-dependency. Workspace uses `russh` 0.63.3.

## Proposal

Backend (`gated-admin`, `gated-protocol-ssh`, `gated-core`, `gated-db-entities`):

1. `gated-protocol-ssh`: a helper that opens a subsystem channel on a connected `RemoteClient` and exposes it as a `tokio::io::DuplexStream` (bridging `RCEvent::Output` and `ChannelOperation::Data`), so `russh_sftp::client::SftpSession` runs on top without touching the client internals.
2. `gated-admin`: an SFTP session registry keyed by (HTTP session, target), created on first use, closed after 5 minutes idle or when the HTTP session ends; at most 4 per user. Each entry registers a gateway session (`protocol = "SFTP"`) so it appears in Sessions and can be closed by an admin.
3. REST endpoints under `/api/sftp/{target}` (utoipa-documented, user API):
   - `GET /list?path=` → entries (name, kind, size, mode, mtime, owner/group ids)
   - `GET /download?path=` → streamed body, `Content-Disposition: attachment`
   - `PUT /upload?path=` → streamed request body; size cap `sftp.max_upload_size` (default 1 GiB) via `DefaultBodyLimit`
   - `POST /mkdir`, `POST /rename`, `DELETE /remove?path=` (files and empty directories)
   - Unknown host key with `prompt` mode → `409` with the fingerprint and a hint to open the terminal once; mismatch → `409` with both fingerprints.
4. `RecordingKind::FileAudit` (`file_audit`) and a `FileAuditRecordingItem` JSON-lines recorder: one item per operation with path, target path for rename, bytes, success and error.
5. Config: `sftp.enable` (default `true`) and `sftp.max_upload_size`.

Frontend (`web/src/features/files/`):

6. Route `/files/$targetName`: path bar, directory table (name, size, modified, mode), toolbar (up, refresh, upload, new folder, rename, delete), download by clicking a file; upload with progress via `XMLHttpRequest`. Entry points: a "Files" action on SSH targets in the targets list and a button on the SSH terminal page.
7. File audit recordings rendered as a table in the recording viewer, like SQL audit.
8. i18n `en` / `zh-CN`, OpenAPI snapshot and generated types, `docs/api.md`.

Tests: Rust unit tests for the stream bridge and the recorder items; integration test in `tests/ssh/` against the SSH test image (list, upload, download, rename, delete, audit recording content, 409 on unknown host key); frontend tests for the file table and API client.

## Risks

- New dependency `russh-sftp`; its client must interoperate with our channel bridge (flow control, EOF). Mitigated by the integration test.
- Large transfers hold an HTTP request open; streaming in both directions avoids buffering whole files in memory. Upload limit protects disk and memory.
- File operations are a new way to change target state; they are only as restricted as target access is. A per-role permission may be wanted before wider use (see Alternatives).
- Session registry lifetime bugs could leak SSH connections; idle timeout and per-user cap bound the damage.

## Scope

About 25 files across `gated-protocol-ssh`, `gated-core`, `gated-db-entities`, `gated-common` (config), `gated-admin`, the web app, OpenAPI snapshots and tests. Estimated two to three working sessions.

## Alternatives

- **WebSocket SFTP channel** instead of REST: one connection per page, natural lifetime, but downloads cannot use the browser's native download and uploads need custom chunking. REST is simpler for transfers.
- **Audit and policy for native SFTP** (parse the pass-through SFTP stream, record operations, optionally make targets read-only): closes the existing audit gap for `sftp`/`scp` clients and may be more valuable for a gateway than the web UI. Suggested as the next task; it reuses the `file_audit` recorder from this one.
- **Per-role "file transfer" permission** now rather than later: one more migration and admin UI field; worth it if some users should get shell but not file transfer.

## Annotations

Approved 2026-10-21 with scope changes:

1. Add a per-role "file transfer" permission (`roles.allow_file_transfer`, default `true` so existing access keeps working). File transfer on a target is allowed when at least one of the user's roles that grants access to the target allows it. Enforced for the web file manager and for native SFTP subsystem requests. Admin UI toggle on the role page.
2. Audit native SFTP as part of this work: parse the pass-through SFTP stream on subsystem channels and write the same `file_audit` items (open for read/write with byte counts, remove, rename, mkdir, rmdir, symlink, setstat), correlating requests and status replies by request id. A read-only target mode stays out of scope.
3. REST interface as proposed.

Implementation deviations (2026-10-21):

- No `sftp.enable` / `sftp.max_upload_size` config: the role permission covers enabling, and the 1 GiB upload limit is a constant checked against `Content-Length` and the streamed byte count.
- `remove` is `POST /remove { path, directory }` instead of `DELETE /remove?path=`, to match the other JSON endpoints.
- Connections are keyed by (user, target) and registered as `WebSFTP` sessions. The channel bridge lives in `gated-admin` (`http_service/api/sftp.rs`) instead of a `gated-protocol-ssh` helper.
- The file manager opens as a workspace tab (like the SQL console) from a "Files" button on the user and admin target detail pages, instead of a `/files/$targetName` route. The recording viewer links `FileAudit` recordings to a new admin "File Records" page (`GET /admin/api/file-records`) instead of rendering them inline.
- The integration test runs with `auto_accept`, so the `409` host key path is verified manually against a `prompt` gateway.
