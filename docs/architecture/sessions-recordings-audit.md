# Sessions, Recordings, Audit, and the Database Layer

## Session registry (`crates/gated-core/src/state.rs`)

`State` (`state.rs:17`) is the in-memory registry of live sessions: a map of
session UUIDs to `SessionState` (`state.rs:131`), which tracks the remote
address, the authenticated user, the selected target, the protocol name, the
session's rate-limiter handles, and a protocol-specific handle implementing
`SessionHandle` (`crates/gated-core/src/protocols/handle.rs:13-14`) whose
single method `close()` lets the admin plane terminate the connection.

`register_session` (`state.rs:38`) assigns the UUID, inserts the in-memory
entry, bumps the `gated_sessions_active` gauge, and writes a `Session` row
(`crates/gated-db-entities/src/Session.rs`) with `started = now`. The
returned guard removes the session on drop: `remove_session`
(`state.rs:100`) deletes the map entry, decrements the gauge, and sets the
row's `ended` timestamp (`mark_session_complete`, `state.rs:117`). A
broadcast channel notifies subscribers (e.g. the admin UI session list) of
changes. Admin-initiated closure goes through
`crates/gated-admin/src/api/sessions_detail.rs`, which calls
`session.handle.close()` on the live entry.

Browser logins are not in this registry; they use the management session
registry described in [management-plane.md](management-plane.md). Web
terminals are registered here as `WebSSH`, `WebMySQL` and `WebPostgreSQL`
sessions; `close()` ends the terminal (status frame, WebSocket close,
upstream disconnect). Live sessions are re-authorized after config reloads
and after user/role/target changes that can revoke access; sessions that
lost authorization are closed.

On startup, `populate_db` (`crates/gated-core/src/db/mod.rs:123`) closes any
sessions/recordings left open by a previous crash.

## Recordings (`crates/gated-core/src/recordings/`)

`SessionRecordings` (`recordings/mod.rs:57`) is the factory: `start()`
(`mod.rs:89`) creates a `Recording` DB row and a buffered async
`RecordingWriter` for a file at `<recordings.path>/<session_id>/<name>`.
Writers flush every few seconds, broadcast appended bytes for live tailing
(`subscribe_live`, `mod.rs:149`), and stamp the row's `ended` time on drop.

Four kinds (`RecordingKind`, `crates/gated-db-entities/src/Recording.rs:10`):

| Kind | Recorder | On-disk format | Producers |
|---|---|---|---|
| `Terminal` | `TerminalRecorder` (`recordings/terminal.rs:81`) | JSON Lines of timestamped input/output/error data and PTY resizes; converted to asciicast v2 for playback | SSH shell/exec channels, Kubernetes exec/attach websockets, web terminals |
| `Traffic` | `TrafficRecorder` (`recordings/traffic.rs:14`) | PCAP with synthesized TCP handshakes | SSH port/socket forwarding |
| `HttpProxy` | HTTP proxy recorder | JSON Lines, one item per request (method, path, headers, bodies, status) | HTTP reverse proxy |
| `SqlAudit` | `StructuredRecorder` (`recordings/structured.rs:43`) | JSON Lines of `SqlAuditRecordingItem::Query` (`structured.rs:27`): SQL text, statement kind, elapsed ms, success, error | MySQL/PostgreSQL proxies, web SQL console |

Playback endpoints (`crates/gated-admin/src/api/recordings_detail.rs`):
asciicast export (`api_get_recording_cast`, line 114), PCAP download
(`api_get_recording_tcpdump`, line 170), HTTP exchange listing (line 73), and
a WebSocket live stream (`api_get_recording_stream`, line 200) that tails an
in-progress terminal recording.

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

- **Engines**: SQLite (default `sqlite:data/db`), PostgreSQL, and MySQL via
  SeaORM/sqlx (`crates/gated-core/src/db/mod.rs:19`).
- **Encryption at rest**: optional SQLCipher for SQLite
  (`make_sqlcipher_connect_options`, `db/mod.rs:49`); the data encryption key
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
  schema is part of `m00001`) and `m00004`–`m00010` add OIDC identity
  columns, hash stored token/ticket secrets, and create command-ACL,
  watermark, name-uniqueness and management-audit schema. Migrations run automatically
  at startup; `populate_db` then seeds the built-in `admin` role and the CA
  certificate if missing.

## Metrics (`crates/gated-core/src/metrics.rs`)

A Prometheus recorder is installed when `metrics.enable` is set
(`install_recorder`, `metrics.rs:27`) and rendered by the observability
listener (`/metrics`, plus `/healthz` and `/readyz`,
`crates/gated/src/commands/run.rs:139-159`). Families
(`metrics.rs:50-70`):

- `gated_sessions_active` (gauge, per protocol)
- `gated_auth_attempts_total` (counter, result/method)
- `gated_db_query_total` and `gated_db_query_duration_seconds`
  (SQL console, per target)
- `gated_rate_limit_rejected_total`
- `gated_config_reload_total`
