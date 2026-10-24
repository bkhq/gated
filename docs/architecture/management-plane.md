# Management Plane

The management plane is the always-on HTTP server from `gated-admin`
(`HTTPProtocolServer`, a `ProtocolServer` implementation), which hosts three
surfaces on one listener: the admin API, the user portal API, and the
embedded SPA. The CLI (`crates/gated`) and the YAML config schema
(`crates/gated-common`) complete the plane.

## HTTP service composition (`crates/gated-admin`)

Route layout (`crates/gated-admin/src/http_service/mod.rs`):

- `/admin/api` — admin REST API (axum + utoipa), wrapped in the
  `require_auth` and `require_admin` middleware so it requires both an
  authenticated session/token *and* the built-in `admin` role
  (`mod.rs:176-177`); OpenAPI spec at `/admin/api/openapi.json` with a
  Stoplight Elements playground.
- `/api` — user portal API (axum + utoipa), available to any authenticated
  session; spec at `/api/openapi.json` (`mod.rs:174`).
- `/api/ssh-terminal`, `/api/db-terminal` — raw WebSocket endpoints for the
  in-browser SSH terminal and SQL console (not expressible in OpenAPI,
  mounted directly).
- `/ui` — the embedded SPA (below); unauthenticated page loads redirect to
  the login route.

Middleware stack (`mod.rs:243-261`), outermost last:

1. `TicketMiddleware` — turns a `gated-ticket` query parameter into a
   scoped session (`middleware/ticket.rs`).
2. `DbLockMiddleware` — while an encrypted database is locked, only the
   encryption-unlock endpoints respond; everything else returns 503.
3. `SessionLayer` — cookie sessions (cookie `gated-http-session`,
   secure flag when TLS is on, configurable max-age); server-side state in
   memory, vacuumed periodically. A login creates a `ManagementSessionHandle`
   in the in-memory management registry (`http_service/session.rs`), not a
   proxy session: browser logins have no `sessions` row and do not appear in
   the session list. They end on logout, idle expiry
   (`admin.session_max_age`), restart, admin revocation
   (`/admin/api/management-sessions`), or a password change (which revokes
   the user's other browser sessions and live proxy sessions).
4. `CookieHostMiddleware` — binds cookies to the expected host to prevent
   cross-subdomain reuse.

Security headers (`X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy`, HSTS when TLS) are set globally.
Requests can also authenticate with the `X-Gated-Token` header (admin token
or API token) instead of a cookie
(`http_service/common.rs`).

### Management audit

`audit_request` (`http_service/management_audit.rs`) records every
`POST`/`PUT`/`PATCH`/`DELETE` under `/admin/api/`, `/api/profile/` and
`/api/auth/` (except the `/admin/api/logs` and `/admin/api/management-audit`
queries) made by an identified actor (the admin token is recorded as
`admin-token`) into the `management_audit` table: a `requested` row before
the handler runs and a `completed` row with the response status. If the
`requested` row cannot be written the action is refused. Unauthenticated
requests (e.g. a login attempt) are not recorded here. Entries are queried
with `POST /admin/api/management-audit`.

### Admin API modules (`crates/gated-admin/src/api/`)

CRUD and operations for: users (+ per-user credentials of every kind and
required-credential policies), roles, targets and target groups, target/role
assignments, sessions (list, detail, close), recordings (fetch, asciicast
export, PCAP export, live stream), tickets, log entries, global parameters,
SSH host keys, known hosts, API tokens, accounts (bound target accounts),
and certificate issuance/revocation.

### User portal API modules (`crates/gated-admin/src/http_service/api/`)

`auth` (login/logout/OTP/SSO/auth-state approval), `info`, `targets_list`
(only targets the user is authorized for), `credentials` (self-service
password/keys/OTP/certificates), `api_tokens`, `tickets`, `db_query` +
`sql_validation` (SQL console), `ssh_terminal` / `db_terminal` (web
terminals), `sso_provider_list` / `sso_provider_detail`, and `encryption`
(pre-unlock bootstrap).

### Login flow

`POST /api/auth/login` starts an auth state; the response state tells the
SPA what to collect next: `OtpNeeded`, `SsoNeeded`,
`WebUserApprovalNeeded`, or `Success`
(`http_service/api/auth.rs`). SSO start/callback endpoints drive the OIDC
exchange described in [auth.md](auth.md). The same portal session is also
where users approve pending SSH/database logins when their policy requires
web approval.

## Embedded web UI (`crates/gated-web` + `web/`)

`gated-web` embeds the built SPA with `rust-embed`
(`crates/gated-web/src/lib.rs:3-5`, folder `web/dist`). The admin service
serves it under `/ui` with an `index.html` SPA fallback
(`http_service/spa.rs:31-32`), immutable caching for hashed assets, and
`no-cache` for `index.html`.

The SPA (`web/`) is React 19 + TanStack Router + Tailwind 4, built with Vite
(base path `/ui/`) and Bun. API clients are generated from the two live
OpenAPI specs by `web/scripts/generate-openapi-types.ts` (with committed
snapshots as fallback). Feature areas:

- **User portal**: login, target list with connection details, web SSH
  terminal (xterm.js) and SQL console, self-service credentials (password,
  SSH keys, TOTP enrollment with QR code, client certificates), API tokens,
  tickets, own sessions.
- **Admin area**: users/roles/target groups/accounts management, target
  configuration (including the HTTP flavor marker), live session monitor
  with close action, recording playback (asciinema player for terminal
  recordings, HTTP exchange viewer, PCAP download), audit log browser,
  global parameters, known hosts.

## CLI (`crates/gated`)

Subcommands (`crates/gated/src/main.rs:44-166`):

| Command | Purpose |
|---|---|
| `setup` / `unattended-setup` | first-run bootstrap: writes the YAML config, creates the data dir, database, admin user, self-signed TLS certs, SSH keys (`main.rs:47,58`) |
| `run` | start all enabled listeners; `--enable-admin-token`, `--admin-port` (accepts the literal `NSL_PORT` for dev) (`main.rs:107`) |
| `check` | validate the config file (`main.rs:118`) |
| `create-user` | create a user, optional password/role (`main.rs:120`) |
| `recover-access` | reset a user's password and credential policy (`main.rs:130`) |
| `client-keys` | print the SSH public keys gated uses toward targets (`main.rs:105`) |
| `healthcheck` | liveness probe; `--deep` adds DB ping, migration status, TLS and SSO checks (`main.rs:143`) |
| `encrypt-existing-db` | migrate a plaintext SQLite database to SQLCipher (`main.rs:155`) |
| `version` | print version (`main.rs:135`) |

`run` wiring is described in [README.md](README.md#deployment-model);
sessions, retention cleanup, config watch, and systemd notification are in
`crates/gated/src/commands/run.rs`.

## Configuration schema (`crates/gated-common/src/config/`)

`GatedConfigStore` (`crates/gated-common/src/config/mod.rs:677`) is the YAML
root:

| Section | Highlights |
|---|---|
| `sso_providers` | list of OIDC providers (see [auth.md](auth.md)) |
| `recordings` | `enable`, `path` (default `./data/recordings`) |
| `external_host` | public hostname used for URLs/SSO redirects |
| `database_url` | secret; default `sqlite:data/db` |
| `ssh` | enable, listen, keys path, host-key verification mode, inactivity timeout, keepalive |
| `http` | listen, TLS cert/key, SNI certificates, session/cookie max-age, `trust_x_forwarded_headers` |
| `proxy` | reverse-proxy listen, TLS cert/key, `base_domain` for host-based routing |
| `mysql` / `postgres` | enable, listen, TLS cert/key |
| `metrics` | enable + listen for `/metrics`, `/healthz`, `/readyz` |
| `encryption` | enable at-rest database encryption |
| `log` | retention (default 7 days), level, console/file sinks, optional syslog socket and OTLP exporter |

Loading: the YAML file (path from `-c`/`GATED_CONFIG`, default
`/etc/gated.yaml`) is merged with `GATED_*` environment overrides; relative
paths resolve against the config file's directory; secrets are wrapped in a
`Secret` type that masks debug output. `config-schema.json` at the repo root
is generated from these types via `schemars` and checked for drift in CI.

Targets are **not** in the YAML: they live in the database and are managed
through the admin API/UI. A target row carries `allow_roles`, an optional
group, an optional byte-rate limit, bound accounts, and a `TargetOptions`
union (`ssh` / `http` / `mysql` / `postgres`,
`crates/gated-common/src/config/target.rs:281-291`).
