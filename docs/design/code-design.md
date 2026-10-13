# Gated Code Design

This document describes the **current** design of the gated codebase: a
bastion-host / access-gateway service (a Warpgate fork) consisting of a
15-crate Rust workspace and a React single-page web UI under `web/`. It is
descriptive, not prescriptive — it documents what exists today, including
where the management plane and the session plane still share state.

All `path:line` references were verified against the tree at the time of
writing.

---

## 1. Workspace layout and crate responsibility matrix

The workspace root `Cargo.toml` declares `members = ["crates/*"]` with the
binary crate `crates/gated` as the default member. Internal dependency edges
below are taken from each crate's `Cargo.toml`.

### 1.1 `gated` (binary)

The CLI entry point and process supervisor. Subcommands are declared in
`crates/gated/src/main.rs` (run, setup/unattended-setup, check, create-user,
recover-access, client-keys, healthcheck, encrypt-existing-db, etc.).

The `run` command (`crates/gated/src/commands/run.rs:161`) wires the whole
gateway together:

- builds `Services` (`run.rs:215`), optionally entering the
  encryption-unlock flow with a minimal pre-unlock HTTP server
  (`run.rs:223-261`, `run_minimal_http_server` at `run.rs:112`);
- installs the database tracing logger (`run.rs:263`);
- starts protocol servers as a `FuturesUnordered` set (`run.rs:270-318`):
  the management/web HTTP server `gated_admin::HTTPProtocolServer` on
  `store.http.listen` (always), `SSHProtocolServer`, `MySQLProtocolServer`,
  `PostgresProtocolServer` (each behind its `enable` flag), and the
  dedicated HTTP reverse-proxy listener
  `gated_protocol_http::server::run_server` on `store.proxy.listen` when
  `store.proxy.enable` is set (`run.rs:310-318`);
- optionally starts a loopback observability listener serving `/metrics`,
  `/healthz`, `/readyz` (`run.rs:144-159`, mounted at `run.rs:320-330`);
- spawns a periodic DB/recordings retention cleanup task (`run.rs:332-357`)
  and a config-file watcher that re-authorizes live sessions on reload
  (`watch_config_and_reload`, `run.rs:414-439`).

Depends on: `gated-admin`, `gated-common`, `gated-ca`, `gated-core`,
`gated-db-entities`, `gated-db-migrations`, `gated-protocol-http`,
`gated-protocol-mysql`, `gated-protocol-postgres`, `gated-protocol-ssh`,
`gated-tls`. Nothing depends on it.

### 1.2 `gated-core`

The shared runtime: session registry, services composition, auth state
machine storage, recordings, rate limiting, database access and encryption,
logging layers, and the protocol-server abstraction.

Key modules:

- `src/services.rs` — `Services` struct (see section 2.1).
- `src/state.rs` — `State` session registry and `SessionState` (section 2.2).
- `src/protocols/mod.rs` — `ProtocolServer` trait and `TargetTestError`;
  `src/protocols/handle.rs` — `SessionHandle` trait and `GatedServerHandle`.
- `src/auth_state_store.rs` — `AuthStateStore` keeping in-flight
  authentication state machines (section 2.5).
- `src/config_providers/` — `ConfigProvider` trait and the
  `DatabaseConfigProvider` implementation (section 2.4).
- `src/recordings/` — `SessionRecordings` manager, `RecordingWriter`,
  `TerminalRecorder`, `TrafficRecorder`, `StructuredRecorder`.
- `src/logging/` — tracing layers, including the database logger that turns
  tracing events into `LogEntry` rows (`src/logging/database.rs`).
- `src/db/`, `src/encryption/` — SeaORM connection lifecycle, SQLCipher
  at-rest encryption runtime and bootstrap-token unlock flow.
- `src/rate_limiting/`, `src/sql_console_rate_limit.rs`,
  `src/db_pool_registry.rs` — rate limiter registry and per-target sqlx pool
  cache for the SQL console.
- `src/data.rs` — `SessionSnapshot` (`data.rs:9`), the API-facing projection
  of a session row used by the admin API.
- `src/healthcheck.rs`, `src/metrics.rs` — deep health probes and the
  Prometheus recorder handle.

Depends on: `gated-ca`, `gated-common`, `gated-db-entities`,
`gated-db-migrations`, `gated-tls`, `gated-sso`. Depended on by: `gated`,
`gated-admin`, and all four protocol crates.

### 1.3 `gated-common`

Foundation types and configuration shared by everything above the leaf
crates.

- `src/config/mod.rs` — `GatedConfig` and the `store.*` sections (listeners,
  TLS paths, recordings, log retention, proxy settings); the config-model
  `User` (`config/mod.rs:197`), `UserDetails` (`:208`), `Role` (`:223`),
  `UserAuthCredential` enum (`:29`), and per-protocol
  `UserRequireCredentialsPolicy` (`:89`).
- `src/config/target.rs` — `Target` (`target.rs:264`) and the per-protocol
  `TargetOptions` union (`target.rs:281`) with `TargetSSHOptions`
  (`target.rs:12`, incl. `SSHTargetAuth` at `:27`), `TargetMySqlOptions`
  (`:73`), `TargetPostgresOptions` (`:100`), and `TargetHttpOptions`
  (`:132`) whose `flavor: HttpProxyFlavor` (`:154`, enum at `:229`)
  distinguishes generic and Kubernetes reverse-proxy targets.
- `src/types/aliases.rs:3-4` — `SessionId = Uuid` and
  `ProtocolName = &'static str`.
- `src/auth/` — credential kinds, the `AuthState` machine and
  `CredentialPolicy` used by all protocols.
- `src/eventhub.rs` — generic filtered pub/sub (`EventHub` at
  `eventhub.rs:70`, `EventSender` at `:8`), used by the SSH server session
  for channel event routing.
- `src/error.rs` — `GatedError`; `src/helpers/` — hashing, OTP, fs modes,
  websocket helpers.

Depends on: `gated-ca`, `gated-sso`, `gated-tls`. Depended on by: nearly
every other crate.

### 1.4 `gated-admin`

The management/web HTTP server. Despite the name it is also the *user*
portal and the HTTP `ProtocolServer` registered on `store.http.listen`
(`HTTPProtocolServer` at `crates/gated-admin/src/http_service/mod.rs:45`,
`ProtocolServer` impl at `mod.rs:99`).

- `src/api/` — the **admin API** (poem-openapi), served under `/admin/api`:
  users, roles, targets, target groups, credentials of all kinds, tickets,
  API tokens, known hosts, parameters, sessions
  (`sessions_list.rs`, `sessions_detail.rs`), recordings
  (`recordings_detail.rs`), and audit logs (`logs.rs`).
  `admin_api_app()` (`src/lib.rs:11`) assembles it together with raw
  endpoints for recording playback (`/recordings/:id/{cast,stream,tcpdump}`)
  and the sessions-changed WebSocket (`/sessions/changes`).
- `src/http_service/` — the listener itself: route table and middleware
  stack (`mod.rs:170-265`), cookie session storage (`session.rs`),
  request authorization (`common.rs`), SPA serving (`spa.rs`), error pages,
  the management-plane catchall (`catchall.rs`).
- `src/http_service/api/` — the **user API** under `/api`: login/auth state
  (`auth.rs`), SSO flows (`sso_provider_list.rs`, `sso_provider_detail.rs`),
  user credential self-service, target listing, tickets, the in-browser SSH
  terminal (`ssh_terminal.rs`), the database terminal and SQL console
  (`db_terminal.rs`, `db_query.rs`), and the encryption unlock endpoints
  (`encryption.rs`).

Depends on: `gated-ca`, `gated-common`, `gated-tls`, `gated-core`,
`gated-db-entities`, `gated-protocol-http`, `gated-protocol-ssh`,
`gated-sso`, `gated-web`. Depended on by: `gated`.

### 1.5 `gated-protocol-ssh`

SSH server (inbound, russh-based) and SSH client (outbound to targets).

- `src/lib.rs` — `SSHProtocolServer` and `PROTOCOL_NAME = "SSH"`
  (`lib.rs:17`).
- `src/server/mod.rs` — accept loop (`run_server` at `mod.rs:32`); each
  connection registers a session (`mod.rs:68`) before SSH protocol setup.
- `src/server/session.rs` — `ServerSession`, the per-connection state
  machine: auth (`get_auth_state` at `session.rs:245`), channel handling,
  recording, target connection.
- `src/server/session_handle.rs` — `SSHSessionHandle`, whose `close()`
  sends `SessionHandleCommand::Close` over an mpsc channel
  (`session_handle.rs:20-24`).
- `src/client/` — outbound SSH (`RemoteClient`), also reused by the admin
  web terminal.
- `src/keys.rs`, `src/known_hosts.rs` — host/client key management and
  known-hosts verification.

Depends on: `gated-common`, `gated-core`, `gated-db-entities`. Depended on
by: `gated`, `gated-admin` (web SSH terminal and connection tests).

### 1.6 `gated-protocol-http`

The dedicated HTTP reverse-proxy listener (separate port from the
management UI; see the module doc at `src/server.rs:1-6`).

- `src/server.rs` — `run_server(services, address, base_domain)`
  (`server.rs:45`); per-request flow: resolve target → authenticate
  (Bearer token or mTLS client certificate, `authenticate_request` at
  `server.rs:177`) → authorize → dispatch (`server.rs:204`).
- `src/resolver.rs` — target resolution by `X-Gated-Target` header with
  Host-based fallback.
- `src/engine.rs` — upstream client construction, header injection, body
  streaming.
- `src/kubernetes/` — Kubernetes flavor: client-certificate auth,
  `RequestCorrelator` session correlation (`kubernetes/correlator.rs`),
  WebSocket bridging for `kubectl exec`.
- `src/recording.rs` — HTTP traffic recording; `src/session_handle.rs` —
  `ApiSessionHandle` / `KubernetesSessionHandle`.
- `PROTOCOL_NAME = "Http"` (`src/lib.rs:13`).

Depends on: `gated-ca`, `gated-common`, `gated-tls`, `gated-core`,
`gated-db-entities`. Depended on by: `gated`, `gated-admin`.

### 1.7 `gated-protocol-mysql`

MySQL wire-protocol proxy. `MySQLProtocolServer` (`src/lib.rs:24`) accepts
TCP, registers a session (`lib.rs:89`), wraps the stream in rate limiters,
and runs `MySqlSession` (`src/session.rs`) which performs the client
handshake, authenticates against gated users, connects to the target
(`src/client.rs`) and records queries as structured SQL audit items
(`session.rs:461-485`). `PROTOCOL_NAME = "MySQL"` (`src/common.rs:5`).

Depends on: `gated-common`, `gated-tls`, `gated-core`,
`gated-db-entities`, `gated-database-protocols`. Depended on by: `gated`.

### 1.8 `gated-protocol-postgres`

PostgreSQL wire-protocol proxy, structurally parallel to the MySQL crate:
`PostgresProtocolServer` registers sessions at `src/lib.rs:101`, the
message-level state machine lives in `src/session.rs` (startup, SASL
auth, query dispatch, SQL audit recording). `PROTOCOL_NAME = "PostgreSQL"`
(`src/common.rs:3`).

Depends on: `gated-common`, `gated-tls`, `gated-core`. Depended on by:
`gated`.

### 1.9 `gated-database-protocols`

Low-level MySQL wire-format primitives (frame encode/decode, capability
flags) extracted from sqlx so the MySQL proxy can speak the protocol
without a full client library. Modules: `src/mysql/`, `src/io/`,
`src/error.rs`. No workspace dependencies; used only by
`gated-protocol-mysql`.

### 1.10 `gated-db-entities`

SeaORM entity definitions, one module per table (22 entities listed in
`src/lib.rs`): `User`, `Role`, `UserRoleAssignment`, `Target`,
`TargetGroup`, `TargetRoleAssignment`, `Account`, `TargetAccount`,
credential tables (`PasswordCredential`, `PublicKeyCredential`,
`CertificateCredential`, `OtpCredential`, `SsoCredential`), `ApiToken`,
`Ticket`, `Session`, `Recording`, `LogEntry`, `KnownHost`,
`CertificateRevocation`, `Parameters`. See section 2.6 for the
session-related entities. Depends on `gated-common` and `gated-tls`;
depended on by `gated`, `gated-admin`, `gated-core`, and the SSH / HTTP /
MySQL protocol crates.

### 1.11 `gated-db-migrations`

SeaORM migration library (`migrate_database` in `src/lib.rs`); the schema
is consolidated in `src/m00001_initial.rs` with later no-op carrier
migrations preserved for idempotency. No workspace dependencies; used by
`gated-core`.

### 1.12 `gated-ca`

Certificate-authority helpers: self-signed root generation, CA
deserialization, client-certificate issuance, PEM serialization and
fingerprints (`src/lib.rs`). Used for the Kubernetes-flavor mTLS client
certificates. No workspace dependencies; used by `gated-common`,
`gated-core`, `gated-admin`, `gated-protocol-http`, and `gated`.

### 1.13 `gated-tls`

Rustls plumbing shared by all TLS-speaking servers: certificate/key bundles
(`src/cert.rs`), SNI and single-cert resolvers (`src/rustls_helpers.rs`),
`MaybeTlsStream` upgrade-on-demand wrapper, bundled root store, and
`TlsMode`. No workspace dependencies; used by `gated-common`,
`gated-core`, `gated-db-entities`, `gated-admin`, and the HTTP / MySQL /
Postgres protocol crates.

### 1.14 `gated-sso`

OpenID Connect integration: provider configuration (`src/config.rs`),
authorization request/response handling, ID-token validation
(`src/sso.rs`). No workspace dependencies; used by `gated-common`,
`gated-core`, and `gated-admin`.

### 1.15 `gated-web`

A five-line asset crate (`src/lib.rs:1-5`): a `rust-embed` derive that
embeds `web/dist` (the built React app) as `Assets`. Used only by
`gated-admin` (section 5.2).

---

## 2. Key types and traits

### 2.1 `Services` — the composition root

`Services` (`crates/gated-core/src/services.rs:58-79`) is a cheaply
clonable bundle of `Arc`-wrapped shared state handed to every protocol
server:

- `db: SharedDatabaseConnection` — `Arc<RwLock<Option<DatabaseConnection>>>`
  (`services.rs:33`); `None` while the encrypted DB is locked. All DB users
  go through `db_required()` (`services.rs:39`), which fails with
  `DbLockedError` (HTTP 423 via its `ResponseError` impl, `services.rs:51`).
- `recordings: Arc<Mutex<SessionRecordings>>` — recording manager.
- `config: Arc<RwLock<GatedConfig>>` — live config (hot-reloaded).
- `state: Arc<RwLock<State>>` — the in-memory session registry.
- `config_provider: Arc<Mutex<ConfigProviderEnum>>` — user/target/credential
  lookup (section 2.4).
- `auth_state_store: Arc<Mutex<AuthStateStore>>` — in-flight auth state
  machines.
- `admin_token: Arc<ArcSwapOption<String>>` — optional static admin API
  token.
- `rate_limiter_registry`, `sql_console_rate_limiter`, `db_pool_registry` —
  rate limiting and the SQL-console pool cache.
- `metrics: Option<Arc<MetricsHandle>>`, `global_params`,
  `encryption_runtime` / `encryption_bootstrap_token` / `encryption_notify`
  for the at-rest-encryption unlock flow.

`Services::new` (`services.rs:86-136`) builds all of this, spawns a
60-second `AuthStateStore::vacuum` loop (`services.rs:103-111`), and
constructs `State`. The database is opened later by `open_db_legacy()` /
`open_db(dek_hex)` (`services.rs:158-180`).

### 2.2 `State`, `SessionState`, and session handles

`State` (`crates/gated-core/src/state.rs:17-22`) is the in-memory session
registry:

```rust
pub struct State {
    pub sessions: HashMap<SessionId, Arc<Mutex<SessionState>>>,
    db: SharedDatabaseConnection,
    rate_limiter_registry: Arc<Mutex<RateLimiterRegistry>>,
    change_sender: broadcast::Sender<()>,
}
```

`State::register_session(this, protocol, SessionStateInit)`
(`state.rs:38-94`) is the single entry point for creating a session of any
kind. It: generates a UUID (`state.rs:45`), inserts a `SessionState` into
the map (`state.rs:53`), increments the `gated_sessions_active` gauge
(`state.rs:55-59`), **inserts a `Session` row into the database**
(`state.rs:61-83`), broadcasts a change notification (`state.rs:85`), and
returns an `Arc<Mutex<GatedServerHandle>>`.

`SessionState` (`state.rs:131-143`) carries `remote_address`,
`user_info: Option<AuthStateUserInfo>`, `target: Option<Target>`, the
protocol-specific `handle: Box<dyn SessionHandle>`, rate limiter handles,
and the stashed protocol name. `SessionStateInit` (`state.rs:145-148`) is
what callers supply: a remote address and a handle.

Two handle layers exist:

- `SessionHandle` (`crates/gated-core/src/protocols/handle.rs:13-15`) is
  the minimal protocol-side contract: `fn close(&mut self)`. Each protocol
  supplies its own implementation (e.g. `SSHSessionHandle` sends a
  `Close` command over a channel,
  `crates/gated-protocol-ssh/src/server/session_handle.rs:20-24`; the web
  terminals share `TerminalSessionHandle`, which wakes the terminal bridge;
  the generic-HTTP `ApiSessionHandle` is a no-op).
- `GatedServerHandle` (`handle.rs:18-24`) is the core-side handle returned
  by `register_session`. It exposes `set_user_info` (`handle.rs:51`) and
  `set_target` (`handle.rs:78`) — each updates both the in-memory
  `SessionState` and the `Session` DB row, then refreshes rate limiters —
  and `wrap_stream` (`handle.rs:106`) which stacks byte-rate limiters onto
  the client stream. Its `Drop` impl (`handle.rs:129-137`) spawns
  `State::remove_session(id)`, making handle drop the universal
  session-termination path.

`SessionSnapshot` (`crates/gated-core/src/data.rs:9`) is the serializable
projection of a `Session` row returned by the admin API.

### 2.3 The protocol-server abstraction

```rust
// crates/gated-core/src/protocols/mod.rs:27-30
pub trait ProtocolServer {
    fn name(&self) -> &'static str;
    fn run(self, address: ListenEndpoint) -> impl Future<Output = Result<()>> + Send;
}
```

`TargetTestError` (`protocols/mod.rs:11-25`) is the shared error type for
target connectivity tests. Implementations:

| Server | Crate / definition | Listener config |
|---|---|---|
| `HTTPProtocolServer` (management + user portal) | `crates/gated-admin/src/http_service/mod.rs:45`, impl at `:99` | `store.http.listen` |
| `SSHProtocolServer` | `crates/gated-protocol-ssh/src/lib.rs` | `store.ssh.listen` |
| `MySQLProtocolServer` | `crates/gated-protocol-mysql/src/lib.rs:24`, impl at `:36` | `store.mysql.listen` |
| `PostgresProtocolServer` | `crates/gated-protocol-postgres/src/lib.rs` | `store.postgres.listen` |

The HTTP reverse-proxy listener is the exception: it is a free function
`gated_protocol_http::server::run_server` (`server.rs:45`) rather than a
`ProtocolServer` impl, pushed into the same future set by
`crates/gated/src/commands/run.rs:310-318`.

### 2.4 `ConfigProvider`

`ConfigProvider` (`crates/gated-core/src/config_providers/mod.rs:23-62`)
abstracts user/target/credential lookup: `list_users`, `list_targets`,
`validate_credential`, `username_for_sso_credential`,
`apply_sso_role_mappings`, `get_credential_policy`, `authorize_target`,
`update_public_key_last_used`, `validate_api_token`. It is dispatched via
`enum_dispatch` through `ConfigProviderEnum` (`mod.rs:16-19`), whose only
variant today is `DatabaseConfigProvider`
(`crates/gated-core/src/config_providers/db.rs`) — all users, roles,
targets and credentials live in the database. The same module also hosts
ticket validation/consumption helpers `authorize_ticket` (`mod.rs:65`) and
`consume_ticket` (`mod.rs:109`).

### 2.5 Authentication state and event/notification mechanisms

`AuthStateStore` (`crates/gated-core/src/auth_state_store.rs:26-30`) maps
auth-state UUIDs to `Arc<Mutex<AuthState>>` plus a timestamp, with a
`vacuum()` (`auth_state_store.rs:156`) expiring stale entries.
`AuthState` (in `gated-common/src/auth/`) is the per-login state machine:
the user's `CredentialPolicy` decides which credential kinds are still
required; protocols feed credentials in until it returns accepted.

Notification channels in the system:

- **Sessions changed**: `State.change_sender` (`state.rs:21`), a
  `broadcast::Sender<()>` fired on register (`state.rs:85`), remove
  (`state.rs:114`), and on `SessionState::emit_change` (`state.rs:167-169`,
  triggered by `set_user_info` / `set_target`). The admin API exposes it as
  the WebSocket `/admin/api/sessions/changes`
  (`crates/gated-admin/src/api/sessions_list.rs:95-111`), which sends an
  empty text frame per event; the UI re-fetches on each frame.
- **Web auth requests**: `AuthStateStore.web_auth_request_signal`
  (`auth_state_store.rs:30`), a `broadcast::Sender<Uuid>` fired when an
  auth state starts waiting for in-browser approval
  (`auth_state_store.rs:111-115`); surfaced to the UI via
  `/api/auth/web-auth-requests/stream`
  (`crates/gated-admin/src/http_service/mod.rs:192-195`).
- **Log pipeline**: a global `broadcast::Sender<LogEntry::ActiveModel>`
  (`crates/gated-core/src/logging/database.rs:14`) decouples tracing from
  DB writes (section 3.5).
- **Encryption unlock**: `Services.encryption_notify` (`services.rs:78`)
  wakes the startup loop when the operator unlocks the DB
  (`run.rs:244-249`).
- **Generic event hub**: `EventHub` / `EventSender`
  (`crates/gated-common/src/eventhub.rs:70`, `:8`) — filtered pub/sub used
  by the SSH server session for event fan-out
  (`crates/gated-protocol-ssh/src/server/session.rs:101-141`).
- **Live recording streams**: per-recording `broadcast::Sender<Bytes>` in
  `SessionRecordings.live` (`crates/gated-core/src/recordings/mod.rs:61`,
  `subscribe_live` at `:149`), feeding the admin recording-stream endpoint.

### 2.6 Database entity model and protocol persistence

Three entities carry all session-plane activity:

**`Session`** (`crates/gated-db-entities/src/Session.rs:5-17`), table
`sessions`: `id: Uuid` (PK), `target_snapshot: Option<String>` (JSON copy
of the `Target` at connect time), `username: Option<String>`,
`remote_address: String`, `started`, `ended: Option<DateTime>`,
`ticket_id: Option<Uuid>`, `protocol: String`. One table for every
session of every protocol — including sessions created by the web UI
itself (section 4).

**`Recording`** (`crates/gated-db-entities/src/Recording.rs:21-34`), table
`recordings`: `id`, `name`, `started`, `ended`, `session_id` (FK to
`sessions`, cascade delete), `kind: RecordingKind`
(`Terminal | Traffic | HttpProxy | SqlAudit`, `Recording.rs:10-19`), and
JSON `metadata`. The row is the index; the bytes live on disk under
`<recordings.path>/<session_id>/<name>`
(`crates/gated-core/src/recordings/mod.rs:170-172`).

**`LogEntry`** (`crates/gated-db-entities/src/LogEntry.rs:8-19`), table
`log`: `id`, `text`, `values: JsonValue`, `timestamp`, `session_id: Uuid`,
`username: Option<String>`. There is no FK relation; `session_id` is a
plain column.

How protocols persist data:

- **Recordings**: a protocol calls
  `SessionRecordings::start::<T: Recorder, _>(session_id, name, metadata)`
  (`recordings/mod.rs:89-147`), which inserts the `Recording` row
  (`mod.rs:124-133`) and returns a typed recorder (`TerminalRecorder`,
  `TrafficRecorder`, or `StructuredRecorder`) wrapping a `RecordingWriter`
  (`recordings/writer.rs:22`). The writer streams to the on-disk file via a
  buffered background task and mirrors bytes to live subscribers; on drop
  it stamps the row's `ended` (`writer.rs:98`, drop at `writer.rs:124`).
- **Log entries**: protocols simply emit `tracing` events inside a session
  span. The `ValuesLogLayer` installed by `make_database_logger_layer`
  (`logging/database.rs:17-29`) extracts the `session` and
  `session_username` span fields (`database.rs:57-63`); events without a
  parseable `session` field are discarded, so only session-scoped activity
  reaches the `log` table. A background task installed by
  `install_database_logger` (`database.rs:31-55`) inserts the rows.
- **Session rows**: written exclusively through `State::register_session`,
  `GatedServerHandle::set_user_info` / `set_target`, and
  `State::mark_session_complete` (section 3).

---

## 3. Session lifecycle end-to-end

### 3.1 Creation and registration

Every proxy session and web terminal goes through
`State::register_session` (`crates/gated-core/src/state.rs:38`). Call
sites:

| Origin | Call site | Protocol string | Handle type | Remote address |
|---|---|---|---|---|
| SSH connection | `crates/gated-protocol-ssh/src/server/mod.rs:68` | `"SSH"` | `SSHSessionHandle` | peer addr |
| MySQL connection | `crates/gated-protocol-mysql/src/lib.rs:89` | `"MySQL"` | `MySqlSessionHandle` | peer addr |
| Postgres connection | `crates/gated-protocol-postgres/src/lib.rs:101` | `"PostgreSQL"` | `PostgresSessionHandle` | peer addr |
| HTTP proxy, generic flavor (per request) | `crates/gated-protocol-http/src/server.rs:243` | `"Http"` | `ApiSessionHandle` | client IP |
| HTTP proxy, Kubernetes flavor (correlated) | `crates/gated-protocol-http/src/kubernetes/correlator.rs:48` | `"Http"` | `KubernetesSessionHandle` | client IP |
| Web SSH terminal | `crates/gated-admin/src/http_service/api/ssh_terminal.rs` | `"WebSSH"` | `WebTerminalSessionHandle` | `None` |
| Web DB terminal | `crates/gated-admin/src/http_service/api/db_terminal.rs` | `"WebMySQL"` / `"WebPostgreSQL"` | `DbTerminalSessionHandle` | `None` |

Browser logins are not registered here; they live in the management
session registry (section 4.1).

The Kubernetes correlator keys cached handles by
`(username, target_name, client_ip)` (`correlator.rs:14`) so a burst of
kubectl requests shares one logical session; generic-flavor HTTP proxying
creates one session per request.

Registration inserts the `Session` row with `started`, `remote_address`,
and `protocol` set, `username`/`target_snapshot`/`ended` null
(`state.rs:64-75`). The caller then fills in identity as it learns it:
`set_user_info` (`protocols/handle.rs:51-76`, updates row `username`) and
`set_target` (`handle.rs:78-104`, updates row `target_snapshot`).

### 3.2 Authentication

Protocols create an `AuthState` via
`AuthStateStore::create(session_id, username, protocol, supported_kinds)`
(`crates/gated-core/src/auth_state_store.rs:78`), which looks the user up
through the `ConfigProvider` and attaches the user's `CredentialPolicy`.
The SSH server does this lazily on first auth attempt
(`crates/gated-protocol-ssh/src/server/session.rs:245`). Credentials are
verified through `ConfigProvider::validate_credential`; when `AuthState`
reports acceptance the protocol proceeds (SSH accepts the auth and lets
the user pick or auto-select a target; the database proxies connect to the
target with stored target credentials). The `WebUserApproval` credential
kind suspends the state machine until an admin/user approves the request
in the browser (section 2.5's web-auth-request signal). Web logins use the
same store via `get_auth_state_for_request`
(`crates/gated-admin/src/http_service/common.rs:310-344`), with the auth
state ID kept in the cookie session.

Ticket-based access bypasses interactive auth:
`authorize_ticket` / `consume_ticket`
(`crates/gated-core/src/config_providers/mod.rs:65`, `:109`) resolve a
ticket secret to a user + fixed target, and the session row records
`ticket_id`.

### 3.3 Recording start

Recordings begin when a protocol has something to record:

- SSH terminal channels: `start_terminal_recording`
  (`crates/gated-protocol-ssh/src/server/session.rs:1203`, also `:506`)
  starts a `TerminalRecorder`; port-forwarding channels record raw traffic
  with `TrafficRecorder`.
- MySQL/Postgres proxies: `StructuredRecorder` SQL-audit items per query
  (`crates/gated-protocol-mysql/src/session.rs:461-485`).
- HTTP proxy: request/response recording via
  `crates/gated-protocol-http/src/recording.rs`.
- Admin web terminals: `TerminalRecorder` started at
  `ssh_terminal.rs:742-759` and `db_terminal.rs:519-531`.

All paths go through `SessionRecordings::start`
(`crates/gated-core/src/recordings/mod.rs:89`), which writes the
`Recording` row and creates the on-disk file. If recordings are disabled
the call returns `Error::Disabled` and protocols continue without
recording.

### 3.4 Activity logging

Anything logged with `tracing` inside a session span (the spans carry
`session` and `session_username` fields; see `span_for_request` usage at
`crates/gated-admin/src/http_service/mod.rs:224-242` and the SSH session's
logging span) is captured by the database logger layer and inserted into
the `log` table asynchronously (`crates/gated-core/src/logging/database.rs:31-55`).
This covers auth attempts, target selection, channel opens, query logs,
and HTTP request results uniformly across protocols.

### 3.5 Close paths

Termination is unified by `GatedServerHandle::Drop`
(`crates/gated-core/src/protocols/handle.rs:129-137`) →
`State::remove_session` (`state.rs:100-115`) → map removal, gauge
decrement, change broadcast, and `mark_session_complete`
(`state.rs:117-128`) which sets the `Session.ended` timestamp.

1. **Client disconnect.** Example, SSH: the session event loop turns
   `RCEvent::Done` or `ServerHandlerEvent::Disconnect` into
   `GatedError::SessionEnd`
   (`crates/gated-protocol-ssh/src/server/session.rs:388-391`); the
   session future ends, the `GatedServerHandle` drops, and the row gets
   its `ended` stamp. MySQL/Postgres sessions end the same way when their
   `run()` future returns (`crates/gated-protocol-mysql/src/lib.rs:111-119`).
   Generic-HTTP per-request sessions drop when the request finishes.

2. **Admin-initiated close.** `POST /admin/api/sessions/:id/close`
   (`crates/gated-admin/src/api/sessions_detail.rs:86-101`) and
   `DELETE /admin/api/sessions`
   (`crates/gated-admin/src/api/sessions_list.rs:76-92`) look the session
   up in `State.sessions` and call `SessionState.handle.close()`
   (`sessions_detail.rs:94-96`, `sessions_list.rs:84-86`). What happens
   next is protocol-specific: the SSH handle sends
   `SessionHandleCommand::Close`, which the session loop answers by
   emitting "Session closed by admin" and disconnecting both sides
   (`crates/gated-protocol-ssh/src/server/session.rs:627-637`); the MySQL
   accept task aborts via its `abort_rx` channel
   (`crates/gated-protocol-mysql/src/lib.rs:116-118`); the web-terminal
   `TerminalSessionHandle` (`http_service/api/common.rs`) notifies the
   bridge, which sends a `closed` status frame, closes the WebSocket and
   disconnects the SSH client or kills the DB CLI process. The HTTP-proxy
   handles are no-ops: each proxied request is authorized on its own, and
   Kubernetes sessions end with correlator expiry.

3. **Expiry / timeout.**
   - SSH inactivity: `store.ssh.inactivity_timeout` is passed into the
     russh server config
     (`crates/gated-protocol-ssh/src/server/mod.rs:108`); russh disconnects,
     funneling into path 1.
   - Kubernetes HTTP sessions: a 60-second vacuum task drops correlator
     handles older than `store.proxy.session_max_age`
     (`crates/gated-protocol-http/src/kubernetes/correlator.rs:72-96`);
     dropping the cached `GatedServerHandle` closes the session.
   - Web (cookie) sessions: `SessionStore::vacuum` drops management
     session handles idle longer than `store.http.session_max_age`
     (`crates/gated-admin/src/http_service/session.rs:169-181`), driven by
     a 60-second loop (`crates/gated-admin/src/http_service/mod.rs:267-272`).

4. **Authorization revoked.** `watch_config_and_reload`
   (`crates/gated/src/commands/run.rs`) runs `Services::revalidate_sessions`
   after a config-file reload and whenever the admin API signals
   `authorization_changed` (deleting a user, role or target, or removing a
   user-role or target-role binding). Every live session is re-checked with
   `authorize_target`; unauthorized ones get `handle.close()`. A failed check
   is logged and leaves that session open.

---

## 4. Current management-plane vs session-plane boundary

There are two HTTP listeners with very different roles:

- **Management/web listener** (`store.http.listen`):
  `gated_admin::HTTPProtocolServer` serves the admin API (`/admin/api`),
  the user API (`/api`), the embedded SPA (`/ui`), the web terminals, and
  a catchall that redirects everything else to the SPA
  (`crates/gated-admin/src/http_service/catchall.rs`).
- **Proxy listener** (`store.proxy.listen`):
  `gated_protocol_http::server::run_server` handles HTTP reverse-proxy
  targets exclusively, authenticating by Bearer token, `?gated-token=` or
  mTLS client certificate — it never uses cookies.

### 4.1 Browser sessions use a separate registry

Admin/user web authentication is cookie-based: poem's `ServerSession`
middleware (cookie `gated-http-session`, in-memory `SharedSessionStorage`)
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

The session list endpoints still exclude `protocol = "ManagementHTTP"` so
rows written before this separation stay hidden.

### 4.2 Web terminals are proxy sessions

The in-browser SSH terminal (`/api/ssh/terminal/:target_name`) and DB
terminals (`/api/{mysql,postgres}/terminal/:target_name`) are mounted on the
management listener but register full sessions via
`State::register_session` with protocols `WebSSH`, `WebMySQL` and
`WebPostgreSQL`, set user/target on the handle, and start
`TerminalRecorder` recordings. Differences from native proxy sessions:
`remote_address` is `None`, the SSH terminal reuses the SSH client from
`gated-protocol-ssh`, the DB terminal spawns a local CLI client process, and
closing the session ends the terminal (section 3.5). A per-user concurrent terminal
cap (`MAX_SESSIONS_PER_USER`) is enforced before the WebSocket upgrade.

### 4.3 Shared in-memory registries

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

### 4.4 Audit storage

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
  `POST /admin/api/logs` and pruned by the session log retention. Rows
  written before `m00010` keep their original meaning and stay here.
- **`sessions`** / **`recordings`**: proxy sessions and web terminals only.

In short: browser authentication and management audit are separated from
the session plane; web terminals, the `AuthStateStore` and `Services` remain
shared.

---

## 5. Frontend / backend contract

### 5.1 API surface and type generation

The backend exposes two OpenAPI documents, both generated by poem-openapi:

- Admin API: `/admin/api/openapi.json`
  (`crates/gated-admin/src/lib.rs:11-26`), guarded by
  `endpoint_auth(endpoint_admin_auth(...))`
  (`crates/gated-admin/src/http_service/mod.rs:175-178`) — cookie session
  or `X-Gated-Token` header plus the built-in admin role
  (`http_service/common.rs:141-176`).
- User API: `/api/openapi.json` (`http_service/mod.rs:163-174`).

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
(`crates/gated-admin/src/http_service/common.rs:178-263`): cookie session
(with cookie-domain/host validation) → `X-Gated-Token` as static admin
token → `X-Gated-Token` as per-user API token.

### 5.2 Asset embedding

`web/` is a React 19 + TypeScript + Vite app (TanStack Router/Query,
Tailwind, xterm.js for terminals, asciinema-player for recording playback;
see `web/package.json`). `vite build` emits `web/dist`, which the
`gated-web` crate embeds at compile time via `rust-embed`
(`crates/gated-web/src/lib.rs:1-5`). `SpaEndpoint`
(`crates/gated-admin/src/http_service/spa.rs:21-43`) serves the embedded
files at `/ui` with hashed-asset caching (`spa.rs:72-78`) and falls back to
`index.html` for client-side routes. The SPA uses hash routing, so deep
links survive the single `/ui` mount.

### 5.3 WebSocket endpoints

| Endpoint | Backend | Frontend consumer | Payload |
|---|---|---|---|
| `/admin/api/sessions/changes` | `crates/gated-admin/src/api/sessions_list.rs:95-111` (mounted at `src/lib.rs:39-42`) | `web/src/features/sessions/hooks/use-sessions-stream.ts` | empty text frame per change; client invalidates its query cache |
| `/api/auth/web-auth-requests/stream` | `crates/gated-admin/src/http_service/api/auth.rs` (mounted at `http_service/mod.rs:192-195`) | `web/src/features/auth-requests/` | pending web-auth-request notifications |
| `/api/ssh/terminal/:target_name` | `http_service/api/ssh_terminal.rs` | `web/src/features/terminal/` | binary frames, first byte = type: `0x00` data, `0x01` resize JSON, `0x02` status JSON, `0x03` host-key verification (`ssh_terminal.rs:41-49`) |
| `/api/mysql/terminal/:t`, `/api/postgres/terminal/:t` | `http_service/api/db_terminal.rs` | same terminal feature | same framing, PTY-backed CLI client |

A shared reconnecting WebSocket hook
(`web/src/shared/hooks/use-websocket.ts`) handles scheme upgrade
(ws/wss), exponential backoff, and pluggable decoding.

Recording playback is plain HTTP streaming, not WebSocket:
`/admin/api/recordings/:id/{cast,stream,tcpdump}`
(`crates/gated-admin/src/lib.rs:27-38`).
