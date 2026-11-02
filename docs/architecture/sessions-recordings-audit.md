# Sessions, Recordings, Audit, and the Database Layer

English | [简体中文](sessions-recordings-audit.zh-CN.md)

## Session registry (`crates/gated-core/src/state.rs`)

`State` (`state.rs`) is the in-memory registry of live sessions: a map of
session UUIDs to `SessionState` (`state.rs`), which tracks the remote
address, the authenticated user, the selected target, the protocol name, the
session's rate-limiter handles, and a protocol-specific handle implementing
`SessionHandle` (`crates/gated-core/src/protocols/handle.rs`) whose
single method `close()` lets the admin plane terminate the connection.

`register_session` assigns the UUID, inserts the in-memory entry and bumps
the `gated_sessions_active` gauge. The `Session` row
(`crates/gated-db-entities/src/Session.rs`) is written only when the user
authenticates (`GatedServerHandle::set_user_info`), so failed logins and
port scans leave no row; each failed login writes one `auth_login_rejected`
audit entry instead. The returned guard removes the session on drop:
`remove_session` deletes the map entry, decrements the gauge, and sets the
row's `ended` timestamp (`mark_session_complete`). A
broadcast channel notifies subscribers (e.g. the admin UI session list) of
changes. Admin-initiated closure goes through
`crates/gated-admin/src/api/sessions_detail.rs`, which calls
`session.handle.close()` on the live entry.

Browser logins are not in this registry; they use the management session
registry described in [management-plane.md](management-plane.md). Web
terminals and the web file manager are registered here as `WebSSH`,
`WebMySQL`, `WebPostgreSQL` and `WebSFTP` sessions; `close()` ends the terminal (status frame, WebSocket close,
upstream disconnect). Live sessions are re-authorized after config reloads
and after user/role/target changes that can revoke access; sessions that
lost authorization are closed.

On startup, `populate_db` (`crates/gated-core/src/db/mod.rs`) closes any
sessions/recordings left open by a previous crash.

## Recordings (`crates/gated-core/src/recordings/`)

`SessionRecordings` (`recordings/mod.rs`) is the factory: `start()`
(`mod.rs`) creates a `Recording` DB row and a buffered async
`RecordingWriter` for a file at `<recordings.path>/<session_id>/<name>`.
Writers flush every few seconds, broadcast appended bytes for live tailing
(`subscribe_live`, `mod.rs`), and stamp the row's `ended` time on drop.

Six kinds (`RecordingKind`, `crates/gated-db-entities/src/Recording.rs`):

| Kind | Recorder | On-disk format | Producers |
|---|---|---|---|
| `Terminal` | `TerminalRecorder` (`recordings/terminal.rs`) | JSON Lines of timestamped input/output/error data and PTY resizes; converted to asciicast v2 for playback | SSH shell/exec channels, Kubernetes exec/attach websockets, web terminals |
| `Traffic` | `TrafficRecorder` (`recordings/traffic.rs`) | PCAP with synthesized TCP handshakes | SSH port/socket forwarding |
| `HttpProxy` | HTTP proxy recorder | JSON Lines, one item per request (method, path, headers, bodies, status) | HTTP reverse proxy |
| `SqlAudit` | `StructuredRecorder` (`recordings/structured.rs`) | JSON Lines of `SqlAuditRecordingItem::Query`: SQL text, statement kind, elapsed ms, success, error | MySQL/PostgreSQL proxies, web SQL console |
| `CommandAudit` | `CommandAuditRecorder` (`structured.rs`) | JSON Lines of `ShellCommandRecordingItem`: command, origin, ACL verdict and outcome | SSH sessions (command control) |
| `FileAudit` | `FileAuditRecorder` (`structured.rs`) | JSON Lines of `FileAuditRecordingItem`: operation, path, bytes, success | native SFTP, web file manager |

Playback endpoints (`crates/gated-admin/src/api/recordings_detail.rs`):
asciicast export (`api_get_recording_cast`), PCAP download
(`api_get_recording_tcpdump`), HTTP exchange listing, and a WebSocket live
stream (`api_get_recording_stream`) that tails an in-progress terminal
recording. Command and file audits are queried through
`/admin/api/command-records` and `/admin/api/file-records`.

Recording is globally opt-in via `recordings.enable`.

## Audit logging (`crates/gated-core/src/logging/`)

Only explicit audit events are persisted:

- `ValuesLogLayer` (`logging/layer.rs`) persists events emitted with
  `target: "audit"` at INFO and above, inheriting values from parent spans
  (session id, username, client IP). Other tracing events go only to the
  console/file sinks.
- The database sink (`logging/database.rs`) inserts them as `LogEntry` rows
  (text, JSON values, timestamp, session id, username), browsable via
  `POST /admin/api/logs` and the admin UI.
- Management write actions are recorded separately in the
  `management_audit` table (see [management-plane.md](management-plane.md)),
  as are session deletions and account credential reveals.
- Optional sinks: a UNIX datagram socket (`log.send_to`,
  `logging/socket.rs`), rolling files, JSON console format, and an OTLP
  exporter (`log` config section).

Retention is enforced by `cleanup_db` (`crates/gated-core/src/db/mod.rs`),
which prunes log entries, ended recordings (rows and files) and ended
sessions older than `log.retention` (default 7 days), and management audit
rows older than `log.management_retention` (default 7 days), on a timer of
one tenth of the shorter retention window.

## Database layer

- **Engines**: SQLite (default `sqlite:data/db`; `setup` writes `sqlite:db`
  under the data directory), PostgreSQL, and MySQL via
  SeaORM/sqlx (`crates/gated-core/src/db/mod.rs`).
- **Encryption at rest**: optional SQLCipher for SQLite
  (`make_sqlcipher_connect_options`, `db/mod.rs`); the data encryption key
  is supplied through the unlock API at startup, and `Services.db` stays
  `None` until unlocked. `gated encrypt-existing-db` migrates plaintext
  databases in place.
- **Entities** (`crates/gated-db-entities/src/`): User, Role,
  UserRoleAssignment, Target, TargetGroup, TargetRoleAssignment,
  TargetAccount, Account, Session, Recording, LogEntry, ManagementAudit,
  CommandAclRule, Ticket, ApiToken, KnownHost, Parameters (includes the CA
  key pair), CertificateRevocation, and the five credential tables (Password, PublicKey, Otp, Sso,
  Certificate).
- **Migrations** (`crates/gated-db-migrations/src/`): `m00001_initial`
  creates the base schema; `m00002`/`m00003` are intentionally empty (their
  schema is part of `m00001`) and `m00004`–`m00012` add OIDC identity
  columns, hash stored token/ticket secrets, and create command-ACL,
  watermark, name-uniqueness, management-audit, site-title and per-role
  file-transfer schema. Migrations run automatically
  at startup; `populate_db` then seeds the built-in `admin` role and the CA
  certificate if missing.

## Metrics (`crates/gated-core/src/metrics.rs`)

A Prometheus recorder is installed when `metrics.enable` is set
(`install_recorder`, `metrics.rs`) and rendered by the observability
listener (`/metrics`, plus `/healthz` and `/readyz`,
`crates/gated/src/commands/run.rs`). Families
(`metrics.rs`):

- `gated_sessions_active` (gauge, per protocol)
- `gated_auth_attempts_total` (counter, result/method)
- `gated_db_query_total` and `gated_db_query_duration_seconds`
  (SQL console, per target)
- `gated_rate_limit_rejected_total`
- `gated_config_reload_total`
