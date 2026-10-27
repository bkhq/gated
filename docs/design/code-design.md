# Gated Code Design

How the main runtime pieces fit together: shared services, the session
registry, the session lifecycle, the boundary between the management plane
and the session plane, and the frontend/backend contract. Crate roles, the
deployment model and per-protocol details are in
[../architecture/README.md](../architecture/README.md).

---

## 1. Key types and traits

### 1.1 `Services` — the composition root

`Services` (`crates/gated-core/src/services.rs`) is a cheaply
cloneable bundle of `Arc`-wrapped shared state handed to every protocol
server:

- `db: SharedDatabaseConnection` — `Arc<RwLock<Option<DatabaseConnection>>>`
  (`services.rs`); `None` while the encrypted DB is locked. All DB users
  go through `db_required()` (`services.rs`), which fails with
  `DbLockedError` (HTTP 423 via its `IntoResponse` impl).
- `recordings: Arc<Mutex<SessionRecordings>>` — recording manager.
- `config: Arc<RwLock<GatedConfig>>` — live config (hot-reloaded).
- `state: Arc<RwLock<State>>` — the in-memory session registry.
- `config_provider: Arc<Mutex<ConfigProviderEnum>>` — user/target/credential
  lookup (section 1.4).
- `auth_state_store: Arc<Mutex<AuthStateStore>>` — in-flight auth state
  machines.
- `admin_token: Arc<ArcSwapOption<String>>` — optional static admin API
  token.
- `rate_limiter_registry`, `sql_console_rate_limiter`, `db_pool_registry` —
  rate limiting and the SQL-console pool cache.
- `metrics: Option<Arc<MetricsHandle>>`, `global_params`,
  `encryption_runtime` / `encryption_bootstrap_token` / `encryption_notify`
  for the at-rest-encryption unlock flow.

`Services::new` (`services.rs`) builds all of this, spawns a
60-second `AuthStateStore::vacuum` loop (`services.rs`), and
constructs `State`. The database is opened later by `open_db_legacy()` /
`open_db(dek_hex)` (`services.rs`).

### 1.2 `State`, `SessionState`, and session handles

`State` (`crates/gated-core/src/state.rs`) is the in-memory session
registry:

```rust
pub struct State {
    pub sessions: HashMap<SessionId, Arc<Mutex<SessionState>>>,
    db: SharedDatabaseConnection,
    rate_limiter_registry: Arc<Mutex<RateLimiterRegistry>>,
    change_sender: broadcast::Sender<()>,
}
```

`State::register_session(this, protocol, SessionStateInit)` is the single
entry point for creating a session of any kind. It generates a UUID, inserts
a `SessionState` into the map, increments the `gated_sessions_active` gauge,
broadcasts a change notification, and returns an
`Arc<Mutex<GatedServerHandle>>`. It does not touch the database: the
`Session` row is inserted when the user authenticates (section 2.1).

`SessionState` (`state.rs`) carries `remote_address`,
`user_info: Option<AuthStateUserInfo>`, `target: Option<Target>`, the
protocol-specific `handle: Box<dyn SessionHandle>`, rate limiter handles,
and the stashed protocol name. `SessionStateInit` (`state.rs`) is
what callers supply: a remote address and a handle.

Two handle layers exist:

- `SessionHandle` (`crates/gated-core/src/protocols/handle.rs`) is
  the minimal protocol-side contract: `fn close(&mut self)`. Each protocol
  supplies its own implementation (e.g. `SSHSessionHandle` sends a
  `Close` command over a channel,
  `crates/gated-protocol-ssh/src/server/session_handle.rs`; the web
  terminals share `TerminalSessionHandle`, which wakes the terminal bridge;
  the generic-HTTP `ApiSessionHandle` is a no-op).
- `GatedServerHandle` (`handle.rs`) is the core-side handle returned
  by `register_session`. `set_user_info` inserts the `Session` row on first
  call and updates `username` afterwards; `set_target` updates the
  in-memory target and, once the row exists, its `target_snapshot`. Both
  refresh rate limiters. `wrap_stream` stacks byte-rate limiters onto the
  client stream. Its `Drop` impl spawns
  `State::remove_session(id)`, making handle drop the universal
  session-termination path.

`SessionSnapshot` (`crates/gated-core/src/data.rs`) is the serializable
projection of a `Session` row returned by the admin API.

### 1.3 The protocol-server abstraction

```rust
// crates/gated-core/src/protocols/mod.rs
pub trait ProtocolServer {
    fn name(&self) -> &'static str;
    fn run(self, address: ListenEndpoint) -> impl Future<Output = Result<()>> + Send;
}
```

Implementations:

| Server | Crate / definition | Listener config |
|---|---|---|
| `HTTPProtocolServer` (management + user portal) | `crates/gated-admin/src/http_service/mod.rs` | `store.admin.listen` |
| `SSHProtocolServer` | `crates/gated-protocol-ssh/src/lib.rs` | `store.ssh.listen` |
| `MySQLProtocolServer` | `crates/gated-protocol-mysql/src/lib.rs` | `store.mysql.listen` |
| `PostgresProtocolServer` | `crates/gated-protocol-postgres/src/lib.rs` | `store.postgres.listen` |

The HTTP reverse-proxy listener is the exception: it is a free function
`gated_protocol_http::server::run_server` (`server.rs`) rather than a
`ProtocolServer` impl, pushed into the same future set by
`crates/gated/src/commands/run.rs`.

### 1.4 `ConfigProvider`

`ConfigProvider` (`crates/gated-core/src/config_providers/mod.rs`)
abstracts user/target/credential lookup: `list_users`, `list_targets`,
`validate_credential`, `username_for_sso_credential`,
`apply_sso_role_mappings`, `get_credential_policy`, `authorize_target`,
`update_public_key_last_used`, `validate_api_token`. It is dispatched via
`enum_dispatch` through `ConfigProviderEnum` (`mod.rs`), whose only
variant today is `DatabaseConfigProvider`
(`crates/gated-core/src/config_providers/db.rs`) — all users, roles,
targets and credentials live in the database. The same module also hosts
ticket validation/consumption helpers `authorize_ticket` (`mod.rs`) and
`consume_ticket` (`mod.rs`).

### 1.5 Authentication state and event/notification mechanisms

`AuthStateStore` (`crates/gated-core/src/auth_state_store.rs`) maps
auth-state UUIDs to `Arc<Mutex<AuthState>>` plus a timestamp, with a
`vacuum()` (`auth_state_store.rs`) expiring stale entries.
`AuthState` (in `gated-common/src/auth/`) is the per-login state machine:
the user's `CredentialPolicy` decides which credential kinds are still
required; protocols feed credentials in until it returns accepted.

Notification channels in the system:

- **Sessions changed**: `State.change_sender` (`state.rs`), a
  `broadcast::Sender<()>` fired on register (`state.rs`), remove
  (`state.rs`), and on `SessionState::emit_change` (`state.rs`,
  triggered by `set_user_info` / `set_target`). The admin API exposes it as
  the WebSocket `/admin/api/sessions/changes`
  (`crates/gated-admin/src/api/sessions_list.rs`), which sends an
  empty text frame per event; the UI re-fetches on each frame.
- **Web auth requests**: `AuthStateStore.web_auth_request_signal`
  (`auth_state_store.rs`), a `broadcast::Sender<Uuid>` fired when an
  auth state starts waiting for in-browser approval
  (`auth_state_store.rs`); surfaced to the UI via
  `/api/auth/web-auth-requests/stream`
  (`crates/gated-admin/src/http_service/mod.rs`).
- **Log pipeline**: a global `broadcast::Sender<LogEntry::ActiveModel>`
  (`crates/gated-core/src/logging/database.rs`) decouples tracing from
  DB writes (section 2.5).
- **Encryption unlock**: `Services.encryption_notify` (`services.rs`)
  wakes the startup loop when the operator unlocks the DB
  (`run.rs`).
- **Generic event hub**: `EventHub` / `EventSender`
  (`crates/gated-common/src/eventhub.rs`) — filtered pub/sub used
  by the SSH server session for event fan-out
  (`crates/gated-protocol-ssh/src/server/session.rs`).
- **Live recording streams**: per-recording `broadcast::Sender<Bytes>` in
  `SessionRecordings.live` (`subscribe_live` in
  `crates/gated-core/src/recordings/mod.rs`), feeding the admin recording-stream endpoint.

### 1.6 Database entity model and protocol persistence

Three entities carry all session-plane activity:

**`Session`** (`crates/gated-db-entities/src/Session.rs`), table
`sessions`: `id: Uuid` (PK), `target_snapshot: Option<String>` (JSON copy
of the `Target` at connect time), `username: Option<String>`,
`remote_address: String`, `started`, `ended: Option<DateTime>`,
`ticket_id: Option<Uuid>`, `protocol: String`. One table for every
session of every protocol — including sessions created by the web UI
itself (section 3).

**`Recording`** (`crates/gated-db-entities/src/Recording.rs`), table
`recordings`: `id`, `name`, `started`, `ended`, `session_id` (FK to
`sessions`, cascade delete), `kind: RecordingKind`
(`Terminal | Traffic | HttpProxy | SqlAudit | CommandAudit | FileAudit`), and
JSON `metadata`. The row is the index; the bytes live on disk under
`<recordings.path>/<session_id>/<name>`
(`crates/gated-core/src/recordings/mod.rs`).

**`LogEntry`** (`crates/gated-db-entities/src/LogEntry.rs`), table
`log`: `id`, `text`, `values: JsonValue`, `timestamp`, `session_id: Uuid`,
`username: Option<String>`. There is no FK relation; `session_id` is a
plain column.

How protocols persist data:

- **Recordings**: a protocol calls
  `SessionRecordings::start::<T: Recorder, _>(session_id, name, metadata)`
  (`recordings/mod.rs`), which inserts the `Recording` row
  (`mod.rs`) and returns a typed recorder (`TerminalRecorder`,
  `TrafficRecorder`, or `StructuredRecorder`) wrapping a `RecordingWriter`
  (`recordings/writer.rs`). The writer streams to the on-disk file via a
  buffered background task and mirrors bytes to live subscribers; on drop
  it stamps the row's `ended`.
- **Log entries**: protocols simply emit `tracing` events inside a session
  span. The `ValuesLogLayer` installed by `make_database_logger_layer`
  (`logging/database.rs`) extracts the `session` and
  `session_username` span fields (`database.rs`); events without a
  parseable `session` field are discarded, so only session-scoped activity
  reaches the `log` table. A background task installed by
  `install_database_logger` (`database.rs`) inserts the rows.
- **Session rows**: written exclusively through
  `GatedServerHandle::set_user_info` / `set_target` and
  `State::mark_session_complete` (section 2).

---

## 2. Session lifecycle end-to-end

### 2.1 Creation and registration

Every proxy session and web terminal goes through
`State::register_session` (`crates/gated-core/src/state.rs`). Call
sites:

| Origin | Call site | Protocol string | Handle type | Remote address |
|---|---|---|---|---|
| SSH connection | `crates/gated-protocol-ssh/src/server/mod.rs` | `"SSH"` | `SSHSessionHandle` | peer addr |
| MySQL connection | `crates/gated-protocol-mysql/src/lib.rs` | `"MySQL"` | `MySqlSessionHandle` | peer addr |
| Postgres connection | `crates/gated-protocol-postgres/src/lib.rs` | `"PostgreSQL"` | `PostgresSessionHandle` | peer addr |
| HTTP proxy, generic flavor (per request) | `crates/gated-protocol-http/src/server.rs` | `"Http"` | `ApiSessionHandle` | client IP |
| HTTP proxy, Kubernetes flavor (correlated) | `crates/gated-protocol-http/src/kubernetes/correlator.rs` | `"Http"` | `KubernetesSessionHandle` | client IP |
| Web SSH terminal | `crates/gated-admin/src/http_service/api/ssh_terminal.rs` | `"WebSSH"` | `TerminalSessionHandle` | `None` |
| Web DB terminal | `crates/gated-admin/src/http_service/api/db_terminal.rs` | `"WebMySQL"` / `"WebPostgreSQL"` | `TerminalSessionHandle` | `None` |
| Web file manager | `crates/gated-admin/src/http_service/api/sftp.rs` | `"WebSFTP"` | `TerminalSessionHandle` | `None` |

Browser logins are not registered here; they live in the management
session registry (section 3.1).

The Kubernetes correlator keys cached handles by
`(username, target_name, client_ip)` (`correlator.rs`) so a burst of
kubectl requests shares one logical session; generic-flavor HTTP proxying
creates one session per request.

Registration only creates the in-memory entry. The `Session` row is
inserted by the first `set_user_info`, i.e. once authentication succeeds,
with `started`, `remote_address`, `protocol`, `username` and any target
already chosen; `set_target` fills `target_snapshot` later. A connection
that never authenticates leaves no row; protocols write one
`auth_login_rejected` audit entry instead, and `mark_session_complete`
skips sessions without a row.

### 2.2 Authentication

Protocols create an `AuthState` via
`AuthStateStore::create(session_id, username, protocol, supported_credential_types)`
(`crates/gated-core/src/auth_state_store.rs`), which looks the user up
through the `ConfigProvider` and attaches the user's `CredentialPolicy`.
The SSH server does this lazily on first auth attempt
(`crates/gated-protocol-ssh/src/server/session.rs`). Credentials are
verified through `ConfigProvider::validate_credential`; when `AuthState`
reports acceptance the protocol proceeds (SSH accepts the auth and lets
the user pick or auto-select a target; the database proxies connect to the
target with stored target credentials). The `WebUserApproval` credential
kind suspends the state machine until an admin/user approves the request
in the browser (section 1.5's web-auth-request signal). Web logins use the
same store via `get_auth_state_for_request`
(`crates/gated-admin/src/http_service/common.rs`), with the auth
state ID kept in the cookie session.

Ticket-based access bypasses interactive auth:
`authorize_ticket` / `consume_ticket`
(`crates/gated-core/src/config_providers/mod.rs`) resolve a
ticket secret to a user + fixed target, and the session row records
`ticket_id`.

### 2.3 Recording start

Recordings begin when a protocol has something to record:

- SSH terminal channels: `start_terminal_recording`
  (`crates/gated-protocol-ssh/src/server/session.rs`)
  starts a `TerminalRecorder`; port-forwarding channels record raw traffic
  with `TrafficRecorder`.
- MySQL/Postgres proxies: `StructuredRecorder` SQL-audit items per query
  (`crates/gated-protocol-mysql/src/session.rs`).
- HTTP proxy: request/response recording via
  `crates/gated-protocol-http/src/recording.rs`.
- Admin web terminals: `TerminalRecorder` started at
  `ssh_terminal.rs` and `db_terminal.rs`.

All paths go through `SessionRecordings::start`
(`crates/gated-core/src/recordings/mod.rs`), which writes the
`Recording` row and creates the on-disk file. If recordings are disabled
the call returns `Error::Disabled` and protocols continue without
recording.

### 2.4 Activity logging

Anything logged with `tracing` inside a session span (the spans carry
`session` and `session_username` fields; see `span_for_request` usage at
`crates/gated-admin/src/http_service/mod.rs` and the SSH session's
logging span) is captured by the database logger layer and inserted into
the `log` table asynchronously (`crates/gated-core/src/logging/database.rs`).
This covers auth attempts, target selection, channel opens, query logs,
and HTTP request results uniformly across protocols.

### 2.5 Close paths

Termination is unified by `GatedServerHandle::Drop`
(`crates/gated-core/src/protocols/handle.rs`) →
`State::remove_session` (`state.rs`) → map removal, gauge
decrement, change broadcast, and `mark_session_complete`
(`state.rs`) which sets the `Session.ended` timestamp.

1. **Client disconnect.** Example, SSH: the session event loop turns
   `RCEvent::Done` or `ServerHandlerEvent::Disconnect` into
   `GatedError::SessionEnd`
   (`crates/gated-protocol-ssh/src/server/session.rs`); the
   session future ends, the `GatedServerHandle` drops, and the row gets
   its `ended` stamp. MySQL/Postgres sessions end the same way when their
   `run()` future returns (`crates/gated-protocol-mysql/src/lib.rs`).
   Generic-HTTP per-request sessions drop when the request finishes.

2. **Admin-initiated close.** `POST /admin/api/sessions/:id/close`
   (`crates/gated-admin/src/api/sessions_detail.rs`) and
   `DELETE /admin/api/sessions`
   (`crates/gated-admin/src/api/sessions_list.rs`) look the session
   up in `State.sessions` and call `SessionState.handle.close()`
   (`sessions_detail.rs`, `sessions_list.rs`). What happens
   next is protocol-specific: the SSH handle sends
   `SessionHandleCommand::Close`, which the session loop answers by
   emitting "Session closed by admin" and disconnecting both sides
   (`crates/gated-protocol-ssh/src/server/session.rs`); the MySQL
   accept task aborts via its `abort_rx` channel
   (`crates/gated-protocol-mysql/src/lib.rs`); the web-terminal
   `TerminalSessionHandle` (`http_service/api/common.rs`) notifies the
   bridge, which sends a `closed` status frame, closes the WebSocket and
   disconnects the SSH client or kills the DB CLI process. The HTTP-proxy
   handles are no-ops: each proxied request is authorized on its own, and
   Kubernetes sessions end with correlator expiry.

3. **Expiry / timeout.**
   - SSH inactivity: `store.ssh.inactivity_timeout` is passed into the
     russh server config
     (`crates/gated-protocol-ssh/src/server/mod.rs`); russh disconnects,
     funneling into path 1.
   - Kubernetes HTTP sessions: a 60-second vacuum task drops correlator
     handles older than `store.http.session_max_age`
     (`crates/gated-protocol-http/src/kubernetes/correlator.rs`);
     dropping the cached `GatedServerHandle` closes the session.
   - Web (cookie) sessions: `SessionStore::vacuum` drops management
     session handles idle longer than `store.admin.session_max_age`
     (`crates/gated-admin/src/http_service/session.rs`), driven by
     a 60-second loop (`crates/gated-admin/src/http_service/mod.rs`).

4. **Authorization revoked.** `watch_config_and_reload`
   (`crates/gated/src/commands/run.rs`) runs `Services::revalidate_sessions`
   after a config-file reload and whenever the admin API signals
   `authorization_changed` (deleting a user, role or target, or removing a
   user-role or target-role binding). Every live session is re-checked with
   `authorize_target`; unauthorized ones get `handle.close()`. A failed check
   is logged and leaves that session open.

---

## 3. Current management-plane vs session-plane boundary

There are two HTTP listeners with very different roles:

- **Management/web listener** (`store.admin.listen`):
  `gated_admin::HTTPProtocolServer` serves the admin API (`/admin/api`),
  the user API (`/api`), the embedded SPA (`/ui`), the web terminals, and
  a catchall that redirects everything else to the SPA
  (`crates/gated-admin/src/http_service/catchall.rs`).
- **Proxy listener** (`store.http.listen`):
  `gated_protocol_http::server::run_server` handles HTTP reverse-proxy
  targets exclusively, authenticating by Bearer token, `?gated-token=` or
  mTLS client certificate — it never uses cookies.

### 3.1 Browser sessions use a separate registry

Admin/user web authentication is cookie-based: the `SessionLayer`
middleware (cookie `gated-http-session`, in-memory storage)
stores a `SessionAuthorization` (`User(username)` or `Ticket {..}`) under
the `auth` key. A successful login calls `authorize_session` →
`SessionStore::create_handle_for`
(`crates/gated-admin/src/http_service/session.rs`), which creates a
`ManagementSessionHandle` (`session_handle.rs`) in the management registry.
It creates no `sessions` row and no `State.sessions` entry, so browser logins
do not appear in the proxy session list, have no recording, and are not
affected by closing proxy sessions.

Management sessions end on logout, on idle expiry (`SessionStore::vacuum`),
or when a password change revokes the user's other sessions
(`SessionStore::revoke_other_sessions`). A request whose cookie refers to a
removed handle has its HTTP session purged in
`SessionStore::process_request`. The registry is in memory only, so a
restart ends every browser session. Admins list and revoke them through
`GET /admin/api/management-sessions` and
`DELETE /admin/api/management-sessions/:id`.

The session list endpoints still exclude `protocol = "ManagementHTTP"`.

### 3.2 Web terminals are proxy sessions

The in-browser SSH terminal (`/api/ssh/terminal/:target_name`) and DB
terminals (`/api/{mysql,postgres}/terminal/:target_name`) are mounted on the
management listener but register full sessions via
`State::register_session` with protocols `WebSSH`, `WebMySQL` and
`WebPostgreSQL`, set user/target on the handle, and start
`TerminalRecorder` recordings. Differences from native proxy sessions:
`remote_address` is `None`, the SSH terminal reuses the SSH client from
`gated-protocol-ssh`, the DB terminal spawns a local CLI client process, and
closing the session ends the terminal (section 2.5). A per-user concurrent terminal
cap (`MAX_SESSIONS_PER_USER`) is enforced before the WebSocket upgrade.

### 3.3 Shared in-memory registries

- `State.sessions` is read by the admin API to close sessions and
  subscribed to for the live-updates WebSocket; it is written by every
  protocol server and by the web terminals.
- `AuthStateStore` is shared between protocols and the web UI: an SSH
  login waiting on `WebUserApproval` is approved from the browser through
  `/api/auth/...` endpoints operating on the same store, connected by the
  `web_auth_request_signal` broadcast
  (`crates/gated-core/src/auth_state_store.rs`). Browser logins also run
  their auth state machine in this store.
- `Services` itself (config, config provider, recordings, rate limiters,
  DB handle) is one shared object across both planes.

### 3.4 Audit storage

- **`management_audit`**: management write actions under `/admin/api/`,
  `/api/profile/` and `/api/auth/` by an identified actor are recorded
  twice by the `audit_request` middleware
  (`crates/gated-admin/src/http_service/management_audit.rs`): a
  `requested` row before the handler runs and a `completed` row with the
  response status. Session/recording deletions (`session.delete`) and
  account credential reveals (`account.credentials.reveal`, with actor,
  reason and confirmation factor) are also recorded here. Queried by `POST /admin/api/management-audit`; pruned by
  `log.management_retention`.
- **`log`**: session-scoped events from the tracing pipeline
  (`crates/gated-core/src/logging/database.rs`), queried by
  `POST /admin/api/logs` and pruned by the session log retention.
- **`sessions`** / **`recordings`**: proxy sessions and web terminals only.

In short: browser authentication and management audit are separated from
the session plane; web terminals, the `AuthStateStore` and `Services` remain
shared.

---

## 4. Frontend / backend contract

### 4.1 API surface and type generation

The backend exposes two OpenAPI documents, both generated with utoipa:

- Admin API: `/admin/api/openapi.json`
  (`crates/gated-admin/src/lib.rs`), guarded by
  `require_auth` and `require_admin`
  (`crates/gated-admin/src/http_service/mod.rs`) — cookie session
  or `X-Gated-Token` header plus the built-in admin role
  (`http_service/common.rs`).
- User API: `/api/openapi.json` (`http_service/mod.rs`).

The frontend does **not** generate client code; it generates TypeScript
*types* with `openapi-typescript`
(`web/scripts/generate-openapi-types.ts`, run via `bun run openapi`):
`/admin/api/openapi.json` → `web/src/shared/lib/api/admin.types.ts` and
`/api/openapi.json` → `web/src/shared/lib/api/user.types.ts`, with
committed snapshot fallbacks under `web/scripts/openapi/`. Hand-written
thin clients in `web/src/shared/lib/api/http.ts` (`userApi` → `/api`,
`adminApi` → `/admin/api`, cookie credentials, a global `onUnauthorized`
hook) are wrapped by feature-level TanStack Query hooks.

Request authorization on the backend is injected once per request by
`inject_request_authorization`
(`crates/gated-admin/src/http_service/common.rs`): cookie session
(with cookie-domain/host validation) → `X-Gated-Token` as static admin
token → `X-Gated-Token` as per-user API token.

### 4.2 Asset embedding

`web/` is a React 19 + TypeScript + Vite app (TanStack Router/Query,
Tailwind, xterm.js for terminals, asciinema-player for recording playback;
see `web/package.json`). `vite build` emits `web/dist`, which the
`gated-web` crate embeds at compile time via `rust-embed`
(`crates/gated-web/src/lib.rs`). `spa_endpoint`
(`crates/gated-admin/src/http_service/spa.rs`) serves the embedded
files at `/ui` with hashed-asset caching and falls back to `index.html`
for client-side routes. The router uses browser history with the `/ui`
basepath, so deep links resolve through that fallback.

### 4.3 WebSocket endpoints

| Endpoint | Backend | Frontend consumer | Payload |
|---|---|---|---|
| `/admin/api/sessions/changes` | `crates/gated-admin/src/api/sessions_list.rs` (mounted at `src/lib.rs`) | `web/src/features/sessions/hooks/use-sessions-stream.ts` | empty text frame per change; client invalidates its query cache |
| `/api/auth/web-auth-requests/stream` | `crates/gated-admin/src/http_service/api/auth.rs` (mounted at `http_service/mod.rs`) | `web/src/features/auth-requests/` | pending web-auth-request notifications |
| `/api/ssh/terminal/:target_name` | `http_service/api/ssh_terminal.rs` | `web/src/features/terminal/` | binary frames, first byte = type: `0x00` data, `0x01` resize JSON, `0x02` status JSON, `0x03` host-key verification (`ssh_terminal.rs`) |
| `/api/mysql/terminal/:t`, `/api/postgres/terminal/:t` | `http_service/api/db_terminal.rs` | same terminal feature | same framing, PTY-backed CLI client |

A shared reconnecting WebSocket hook
(`web/src/shared/hooks/use-websocket.ts`) handles scheme upgrade
(ws/wss), exponential backoff, and pluggable decoding.

Recording playback is plain HTTP streaming, not WebSocket:
`/admin/api/recordings/:id/{cast,stream,tcpdump}`
(`crates/gated-admin/src/lib.rs`).
