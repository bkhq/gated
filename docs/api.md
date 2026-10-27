# Gated Backend HTTP API Reference

English | [简体中文](api.zh-CN.md)

This document lists every HTTP endpoint the backend exposes, with request and
response shapes.

Conventions:

- Path parameters are written as `:name`.
- `[OAS]` marks OpenAPI routes (listed in `/api/openapi.json` or `/admin/api/openapi.json`); `[raw]` marks raw / upgrade routes (WebSocket, streaming, file transfer).
- Field types use TS-style notation: `string`, `number`, `uuid` (string), `date-time` (RFC 3339 UTC string), `T[]`, `T | null`, `?: T` (optional).
- Fields marked **secret — write-only** appear only in write requests; fields marked **secret — one-time reveal** appear once in the create response and are never returned by any read endpoint.

Source locations:

- `crates/gated-admin/src/api/**` — admin OpenAPI
- `crates/gated-admin/src/http_service/api/**` — user OpenAPI and raw endpoints
- `crates/gated-admin/src/http_service/mod.rs`, `crates/gated-admin/src/lib.rs`, `crates/gated/src/commands/run.rs` — explicit route mounting

---

## 1. User API (prefix `/api`)

### 1.1 Authentication (`auth.rs`)

#### `POST /api/auth/login` — `login` [OAS]

- Summary: start or advance the HTTP session's `AuthState` with username + password.
- Path / Query: none.
- Body (`Json<LoginRequest>`):
  - `username: string`
  - `password: string` (secret — write-only)
- Responses:
  - `201 Created` — empty body; the server writes or refreshes the `gated-http-session` cookie and stores `SessionAuthorization::User(username)` in the session.
  - `401 Unauthorized` — `Json<LoginFailureResponse> { state: ApiAuthState }`. `Failed` = rejected; `*Needed` means the password was accepted but another factor is required.

#### `POST /api/auth/otp` — `otpLogin` [OAS]

- Summary: submit a TOTP code as the next factor of the session's `AuthState`.
- Body: `{ otp: string }` (secret — write-only).
- Responses:
  - `201 Created` — empty body; the session is upgraded as for `login`.
  - `401 Unauthorized` — `Json<LoginFailureResponse>`; `NotStarted` means the session has no `auth_state_id`.

#### `POST /api/auth/logout` — `logout` [OAS]

- Summary: clear the current session and drop its server-side handle in the `SessionStore`.
- Body: none.
- Responses: `201 Created`, empty body.

#### `GET /api/auth/state` — `get_default_auth_state` [OAS]

- Summary: return the in-progress `AuthState` referenced by the session's `auth_state_id`.
- Responses:
  - `200 OK` — `Json<AuthStateDescription>`.
  - `404 Not Found` — the session has no `auth_state_id`, or the state is gone from the store.

#### `DELETE /api/auth/state` — `cancel_default_auth` [OAS]

- Summary: force-reject the session's in-progress `AuthState`, remove it from the store and clear the id from the session.
- Responses:
  - `200 OK` — `Json<AuthStateDescription>` (`state: Failed`).
  - `404 Not Found` — no state attached to the session.

#### `GET /api/auth/web-auth-requests` — `get_web_auth_requests` [OAS]

- Summary: list every `AuthState` of the current user that is waiting for browser approval. Wrapped in `require_auth`; the caller must be `Session::User`.
- Responses:
  - `200 OK` — `Json<AuthStateDescription[]>`.
  - `404 Not Found` — the authorization is not `Session::User` (for example `UserToken` / `AdminToken` / `Ticket`).
  - `401 Unauthorized` — rejected by `require_auth` (no credentials).

#### `GET /api/auth/state/:id` — `get_auth_state` [OAS]

- Summary: fetch an `AuthState` by id; it must belong to the current user (checked by username).
- Path: `id: uuid`.
- Responses: `200 OK` `Json<AuthStateDescription>` / `404` / `401` (as above).

#### `POST /api/auth/state/:id/approve` — `approve_auth` [OAS]

- Summary: add `WebUserApproval` to the given `AuthState`; `complete` it if the policy is now satisfied.
- Path: `id: uuid`.
- Responses: `200 OK` `Json<AuthStateDescription>` (may be `Success`) / `404` / `401`.

#### `POST /api/auth/state/:id/reject` — `reject_auth` [OAS]

- Summary: reject the given `AuthState`.
- Path: `id: uuid`.
- Responses: `200 OK` `Json<AuthStateDescription>` (`state: Failed`) / `404` / `401`.

#### `POST /api/auth/state/continue` — `continue_default_auth` [OAS]

- Summary: called by the browser that started a login once its remaining factor was granted by web approval on another device. The approve endpoint runs in the approver's session, so it cannot authorize the requester's HTTP session.
- Responses: `200 OK` `Json<AuthStateDescription>`; when the state is `Success` it also authorizes the current session, clears `auth_state_id` and writes an `auth_web_approval_succeeded` audit entry. `404` when the session has no `auth_state_id` or the state is gone from the store.

#### `GET /api/auth/web-auth-requests/stream` — `api_get_web_auth_requests_stream` [raw]

- Upgrades to a **WebSocket** (not SSE). Requires `Session::User`; otherwise `require_auth` returns `401`.
- After the upgrade, every `auth_state_store.subscribe_web_auth_request()` broadcast whose username matches the current user is sent as a `Message::Text(payload)`, where the payload is the bare `AuthState` UUID. The client then fetches details with `GET /api/auth/state/:id`. There is no heartbeat; any send or receive error closes the connection.

### 1.2 SSO (`sso_provider_list.rs`, `sso_provider_detail.rs`)

#### `GET /api/sso/providers` — `get_sso_providers` [OAS]

- Summary: list the configured SSO providers (sorted by `label`).
- Responses: `200 OK` `Json<SsoProviderDescription[]>`.

#### `GET /api/sso/providers/:name/start` — `start_sso` [OAS]

- Summary: start the SSO flow: build the callback URL (it must pass the provider's `return_domain_whitelist`), create an `SsoLoginRequest` and store the `SsoContext` in the session.
- Path: `name: string`.
- Query: `next?: string` — relative path to return to after SSO succeeds (stored in `SsoContext.next_url`).
- Responses:
  - `200 OK` — `Json<StartSsoResponseParams> { url: string }`.
  - `404 Not Found` — no matching provider.

#### `GET /api/sso/return` — `return_to_sso` [OAS]

- Summary: OAuth/OIDC callback (the provider sends the browser back here with `?code=`). Verifies the code, exchanges it for an ID token, maps the email to a username, completes the `AuthState`, applies SSO group → role mappings, then redirects to `next_url`.
- Query: `code?: string`.
- Responses:
  - `307 Temporary Redirect` — `Location` is `<next_url>` (success) or `/ui/?login_error=<msg>` (failure). If `next_url` starts with `/` and `SsoContext.return_host` was recorded, it is rewritten to `https://<return_host><next_url>`. On success the session becomes a user session and stores `SsoLoginState`.

#### `POST /api/sso/return` — `return_to_sso_with_form_data` [OAS]

- Summary: the equivalent endpoint for providers using `response_mode=form_post` (Apple and others).
- Body: `Form<ReturnToSsoFormData>` (`application/x-www-form-urlencoded`) `{ code?: string }`.
- Responses: `200 OK` `Html<string>` — a page that sets `location.href = <url>`.

#### `GET /api/sso/logout` — `initiate_sso_logout` [OAS]

- Summary: start single logout at the IdP with the ID token from the session's `SsoLoginState`; the local session is cleared first regardless of the outcome.
- Responses:
  - `200 OK` — `Json<StartSloResponseParams> { url: string }`.
  - `400 Bad Request` — the session has no `SsoLoginState`.
  - `404 Not Found` — the configured provider has been removed.

### 1.3 Instance info and targets (`info.rs`, `targets_list.rs`)

#### `GET /api/info` — `get_info` [OAS]

- Summary: instance and session information used by the SPA at startup.
- Responses: `200 OK` `Json<Info>`. `site_title` (`null` when unset) is returned to unauthenticated requests too, for the login page. Without authentication `version` and `ports.*` are `null`; `setup_state` is returned only to admins and only while the user or target count is ≤ 1.

#### `GET /api/targets` — `get_targets` [OAS]

- Summary: list the targets the current principal can access. Wrapped in `require_auth`.
- Query: `search?: string` — case-insensitive substring of the target name or group name.
- Responses: `200 OK` `Json<TargetSnapshot[]>`. A ticket session sees only the ticket's target.

### 1.4 Own credentials (`credentials.rs`)

> All of these paths are wrapped in `parameters_based_auth`: when `parameters.allow_own_credential_management = false`, **every** endpoint returns `403 Forbidden` with the plain text `"Credential management is disabled"` instead of the OpenAPI `403` variant.

#### `GET /api/profile/credentials` — `get_my_credentials` [OAS]

- Responses: `200 OK` `Json<CredentialsState>` / `401 Unauthorized` (the principal does not resolve to a `User`) / `403` (parameter switch).

#### `POST /api/profile/credentials/password` — `change_my_password` [OAS]

- Body: `{ password: string }` (secret — write-only).
- Responses: `201 Created` `Json<PasswordState>` (the literal `"Set"`) / `401` / `403`.

#### `POST /api/profile/credentials/public-keys` — `add_my_public_key` [OAS]

- Body: `Json<NewPublicKeyCredential> { label: string, openssh_public_key: string }`.
- Responses: `201 Created` `Json<ExistingPublicKeyCredential>` / `401` / `403`. Only `abbreviated` is returned, **not the full key**.

#### `DELETE /api/profile/credentials/public-keys/:id` — `delete_my_public_key` [OAS]

- Path: `id: uuid`.
- Responses: `204` / `401` / `404` / `403`.

#### `POST /api/profile/credentials/otp/begin` — `begin_my_otp` [OAS]

- Starts OTP enrollment: the server generates the secret and keeps it pending confirmation for 10 minutes. Only the provisioning URI is returned, never the raw secret.
- Responses: `201 Created` `{ provisioning_uri: string }` (`otpauth://`) / `401` / `403` (including ticket sessions).

#### `POST /api/profile/credentials/otp` — `add_my_otp` [OAS]

- Confirms OTP enrollment: Body `{ otp: string }`, a current code for the secret generated by `begin`. Only then is the credential stored and `Totp` pushed onto the `http`/`ssh` policies.
- Responses: `201 Created` `Json<ExistingOtpCredential> { id: uuid }` / `401` / `403`.

#### `DELETE /api/profile/credentials/otp/:id` — `delete_my_otp` [OAS]

- If the user has no OTP left afterwards, the `Totp` requirement is removed from the credential policy.
- Responses: `204` / `401` / `404` / `403`.

#### `POST /api/profile/credentials/certificates` — `issue_my_certificate` [OAS]

- Body: `Json<IssueCertificateCredentialRequest> { label: string, public_key_pem: string }`.
- Responses: `201 Created` `Json<IssuedCertificateCredential>` with `credential` + `certificate_pem` (secret — one-time reveal) / `401` / `403`.

#### `DELETE /api/profile/credentials/certificates/:id` — `revoke_my_certificate` [OAS]

- Writes a `CertificateRevocation` row, then deletes the credential.
- Responses: `200 OK` with an empty body (the implementation uses the `Ok` variant, not `Ok(Json)`) / `401` / `404` / `403`.

### 1.5 Own API tokens (`api_tokens.rs`)

#### `GET /api/profile/api-tokens` — `get_my_api_tokens` [OAS]

- Responses: `200 OK` `Json<ExistingApiToken[]>` / `401`.

#### `POST /api/profile/api-tokens` — `create_api_token` [OAS]

- Body: `Json<NewApiToken> { label: string, expiry: date-time }`.
- Responses: `201 Created` `Json<TokenAndSecret> { token, secret }` (`secret` — one-time reveal) / `401`.

#### `DELETE /api/profile/api-tokens/:id` — `delete_my_api_token` [OAS]

- Responses: `204` / `401` / `404`.

### 1.6 Own tickets (`tickets.rs`)

#### `GET /api/profile/tickets` — `get_my_tickets` [OAS]

- Responses: `200 OK` `Json<ExistingProfileTicket[]>` / `401`.

#### `POST /api/profile/tickets` — `create_my_ticket` [OAS]

- Body: `Json<NewProfileTicket>`:
  - `target_name: string` (must not be empty after trimming)
  - `expiry?: date-time | null` (must be in the future when given)
  - `number_of_uses?: int16 | null` (must be > 0 when given; `null` = unlimited)
  - `description?: string | null`
- Responses:
  - `201 Created` — `Json<ProfileTicketAndSecret> { ticket, secret }` (`secret` — one-time reveal).
  - `400 Bad Request` — `Json<string>`: `"target_name is required"` / `"expiry must be in the future"` / `"number_of_uses must be positive"`.
  - `401` / `403 Forbidden` — `Json<string> "not authorized for this target"`.

#### `DELETE /api/profile/tickets/:id` — `delete_my_ticket` [OAS]

- Responses: `204` / `401` / `404`.

### 1.6.1 Own sessions (`sessions.rs`)

#### `GET /api/profile/sessions` — `get_my_sessions` [OAS]

- The current user's own sessions, newest first, at most 500; management HTTP sessions are excluded.
- Responses: `200 OK` `Json<SessionSnapshot[]>` / `401`.

### 1.7 SQL console (`db_query.rs`)

> Errors from all four endpoints use the `DbError` envelope `Json<ErrorBody> { error: string }`; `429` also carries `Retry-After: <seconds>`. Status codes: `400 / 401 / 403 / 404 / 429 / 500 / 502`.

#### `GET /api/db/schemas/:target_name` — `get_db_schemas` [OAS]

- Path: `target_name: string` (`^[A-Za-z0-9._-]+$`, ≤ 128 characters).
- Responses: `200 OK` `Json<SchemaList> { schemas: string[], default_schema?: string, readonly: bool, kind: "MySql" | "Postgres" }`. System schemas (`mysql` / `performance_schema` / `information_schema` / `sys`, and `information_schema` / `pg_*`) are excluded.

#### `GET /api/db/tables/:target_name` — `get_db_tables` [OAS]

- Query: `schema: string` (required; missing or empty → `400 "schema query param required"`).
- Responses: `200 OK` `Json<TableList> { tables: { name: string, type: string }[] }`.

#### `GET /api/db/columns/:target_name` — `get_db_columns` [OAS]

- Query: `schema: string`, `table: string`.
- Responses: `200 OK` `Json<ColumnList> { columns: { name, data_type, nullable, primary_key }[] }`.

#### `POST /api/db/query/:target_name` — `run_db_query` [OAS]

- Body:
  - `sql: string` (must not be empty after trimming)
  - `limit?: int64 | null` (default 1000, clamped to [1, 10000])
  - `console_session_key?: string | null` (requests with the same key share one audit recording; the session id is a UUIDv5-style id built from the first 16 bytes of SHA-256(key))
- Responses: `200 OK` `Json<QueryResponse>` (see the schemas section).
- Behavior: `validate_readonly_sql` enforces the read-only constraint before execution (violations return `403`); 30 s server-side timeout; results are truncated (`truncated: true`) once rows reach `limit` or the JSON reaches 5 MiB.

### 1.8 Terminal WebSockets (not OpenAPI)

#### `GET /api/ssh/terminal/:target_name` — `api_ssh_terminal` [raw]

- Checks before the upgrade: `target_name` must match the pattern, otherwise `400 "Invalid target name"`; unauthenticated → `401 "Not authenticated"`; more than `MAX_SESSIONS_PER_USER = 10` concurrent sessions → `429 "Too many concurrent terminal sessions"`.
- After the upgrade frames are binary; the first byte is the message type, the rest is the payload:
  - `0x00 MSG_TERMINAL_DATA` — both directions: raw terminal bytes.
  - `0x01 MSG_RESIZE` — client → server: JSON `{ cols: u32, rows: u32 }`.
  - `0x02 MSG_STATUS` — server → client: JSON `{ status, message }`, `status` ∈ `"info" | "connected" | "closed" | "error" | "rate_limited"`.
    The `connected` frame also carries `details`: `{ session_id, address, username, host_key?: { algorithm, fingerprint } }` (SSH); database terminals send `{ session_id, address, username, tls: { mode, verify }, client, database? }`.
  - `0x03 MSG_HOST_KEY_VERIFY` — only when `ssh.host_key_verification = prompt` and the remote host key is unknown:
    - server → client: `{ status: "host_key_verify", algorithm, key_base64, fingerprint, host, port }`; `fingerprint` is the OpenSSH `SHA256:…` form, `host`/`port` the target address.
    - client → server: `{ accepted: bool }`, which must arrive within 60 s.
- Keepalive: the server sends `Ping` every 30 s. There are no custom close codes; errors are reported in a final `MSG_STATUS` frame.
- Host key errors: when a known host key differs, the `MSG_STATUS {status:"error"}` message starts with `Host key mismatch` and gives both the received and the known `SHA256:` fingerprints; when `auto_reject` refuses an unknown key, the message asks an admin to add it under Known hosts.

#### `GET /api/mysql/terminal/:target_name` — `api_mysql_terminal` [raw]
#### `GET /api/postgres/terminal/:target_name` — `api_postgres_terminal` [raw]

- The server spawns a real `mysql` / `psql` binary and bridges its PTY to the WebSocket. Account, password (`MYSQL_PWD` / `PGPASSWORD`), TLS mode, host/port and default database come from the target's stored configuration.
- `400 / 401` before the upgrade; when `sql_console_rate_limiter` is exceeded, a `MSG_STATUS {status:"rate_limited",...}` frame is sent right after the upgrade and the socket is closed.
- Same framing as SSH, but `MSG_RESIZE` uses `u16` and there is no `0x03`. `MSG_STATUS.status` ∈ `"connected" | "error" | "rate_limited"`.

### 1.9 File manager (`sftp.rs`)

> Opens an SFTP subsystem on SSH targets through the gateway's own SSH client. Besides target authorization, the user needs at least one role with `allow_file_transfer = true` on that target, otherwise `403 "File transfer is not allowed on this target"`. Errors are `Json<SftpErrorBody> { error: string }`; status codes `400 / 401 / 403 / 404 / 409 / 413 / 429 / 500 / 502`. SFTP `NoSuchFile` → `404`, `PermissionDenied` → `403`, other SFTP statuses → `400`, transport errors → `502`.

- Connections: one SFTP connection is reused per (user, target) and closed after 5 idle minutes; at most 4 connections per user, beyond that `429`. Each connection is registered as a `WebSFTP` session and can be closed from session monitoring.
- Host keys: unknown keys are accepted only under `auto_accept`; otherwise `409` with the `SHA256:` fingerprint, asking the user to confirm through the web terminal first. A mismatching known key is also `409`.
- Audit: every change and transfer (but not directory listings) is written to that session's `FileAudit` recording named `web-files` (`origin: "web"`), plus one `target: audit` log entry; see §2.14 for queries.

#### `GET /api/sftp/:target_name/list` — `sftp_list` [OAS]

- Query: `path?: string` (defaults to the login directory).
- Responses: `200 OK` `Json<SftpListing> { path: string, entries: SftpEntry[] }`; `path` is the normalized absolute path, `entries` lists directories first, sorted by name, without `.`/`..`.

#### `POST /api/sftp/:target_name/mkdir` — `sftp_mkdir` [OAS]
#### `POST /api/sftp/:target_name/rename` — `sftp_rename` [OAS]
#### `POST /api/sftp/:target_name/remove` — `sftp_remove` [OAS]

- Body: `{ path }` / `{ from, to }` / `{ path, directory?: bool }` (`directory: true` removes an empty directory).
- Responses: `204`.

#### `GET /api/sftp/:target_name/download` — `api_sftp_download` [raw]

- Query: `path: string`. Streams `application/octet-stream` with `Content-Disposition: attachment` (RFC 5987 filename) and `Content-Length` when known. The actual byte count is audited when the transfer ends.

#### `PUT /api/sftp/:target_name/upload` — `api_sftp_upload` [raw]

- Query: `path: string`, `overwrite?: bool`. The request body is the file content, streamed to the target.
- Responses: `204`; `409` when the file exists and `overwrite=true` is not set; `413` above 1 GiB.

### 1.10 OpenAPI metadata

- `GET /api/openapi.json` — the specification.
- `GET /api/playground` — Stoplight Elements UI.

---

## 2. Admin API (prefix `/admin/api`)

### 2.1 Sessions (`sessions_list.rs`, `sessions_detail.rs`)

#### `GET /admin/api/sessions` — `get_sessions` [OAS]

- Query: `offset?: u64` (default 0), `limit?: u64` (default 100), `active_only?: bool` (default false), `closed_only?: bool` (default false, ended sessions only), `logged_in_only?: bool` (default false), `protocol?: ssh|mysql|postgres|http` (protocol family, including the matching web terminals/SFTP; unknown values return nothing), `search?: string` (matches the username or target snapshot, and the session id for a full UUID), `since?: RFC3339` (started at or after), `target_id?: uuid`, `username?: string` (exact match).
- Session rows are written only when authentication succeeds. A connection whose authentication fails creates no session and writes one `auth_login_rejected` audit entry instead (`protocol`, `username`, `target`, `client_ip`, plus `methods` for SSH).
- Responses: `200 OK` `Json<PaginatedResponse<SessionSnapshot>>`.

#### `DELETE /admin/api/sessions` — `close_all_sessions` [OAS]

- Closes every live session in memory and clears the caller's own cookie session.
- Responses: `201 Created`, empty body.

#### `GET /admin/api/sessions/:id` — `get_session` [OAS]

- Responses: `200 OK` `Json<SessionSnapshot>` / `404`.

#### `GET /admin/api/sessions/:id/recordings` — `get_session_recordings` [OAS]

- Responses: `200 OK` `Json<Recording[]>` (newest first).

#### `POST /admin/api/sessions/:id/close` — `close_session` [OAS]

- Responses: `201 Created` empty body / `404` (the session is not live).

#### `POST /admin/api/sessions/:id/terminate` — `terminate_session` [OAS]

- Forced termination: signals the session handle and immediately removes the session from the live registry, marking it ended in the database, so a wedged protocol loop cannot keep it alive. `close` only signals and waits for the protocol loop to exit.
- Responses: `201 Created` empty body / `404`.

#### `DELETE /admin/api/sessions/:id` — `delete_session` [OAS]

- Deletes the session record with its recording files and rows and its log rows; a live session is closed first. A management audit entry is written before anything is deleted.
- Responses: `200` empty body / `404`.

#### `DELETE /admin/api/sessions/closed` — `delete_closed_sessions` [OAS]

- Deletes every ended session with its recordings and log rows; live sessions are untouched. A management audit entry is written before anything is deleted.
- Responses: `200 OK` `Json<number>` (number of sessions deleted).

#### `GET /admin/api/sessions/changes` — `api_get_sessions_changes_stream` [raw]

- Upgrades to a WebSocket (**not** SSE). Each global session broadcast sends an empty `Text("")` frame ("something changed, refetch").

### 2.2 Recordings (`recordings_detail.rs` + raw routes in `lib.rs`)

#### `GET /admin/api/recordings/:id` — `get_recording` [OAS]

- Responses: `200 OK` `Json<Recording>` / `404`.

#### `GET /admin/api/recordings/:id/http-proxy` — `get_http_proxy_recording` [OAS]

- Note: the handler declares no security scheme (no `AnySecurityScheme` parameter).
- Responses: `200 OK` `Json<HttpProxyRecordingItem[]>`; `404` when the recording does not exist or is not `http_proxy`.

#### `GET /admin/api/recordings/:id/cast` — `api_get_recording_cast` [raw]

- Returns an asciinema asciicast v2 stream; `Content-Type: text/plain; charset=utf-8`, one JSON value per line separated by `\n`. The first line is `{"version":2,"width":W,"height":H,"title":<name>,"time":0.0}`; each following line is either a new header (PTY resize) or `[time, "i"|"o"|"e", data]`.
- `404` when the recording is missing or not `terminal`; `500` on file / JSON errors.

#### `GET /admin/api/recordings/:id/stream` — `api_get_recording_stream` [raw]

- Upgrades to a WebSocket. The first text frame is `{ start: true, live: bool }`. When `live`, `{ data: AsciiCast }` frames follow and finally `{ end: true }`; when not live, only the start frame is sent.

#### `GET /admin/api/recordings/:id/tcpdump` — `api_get_recording_tcpdump` [raw]

- `Content-Type: application/octet-stream`, raw pcap bytes.
- `404` when the recording is missing or not `traffic`; `500` on file I/O errors.

### 2.3 Users (`users.rs`)

#### `GET /admin/api/users` — `get_users` [OAS]

- Query: `search?: string` — `LIKE %search%`.
- Responses: `200 OK` `User[]`.

#### `POST /admin/api/users` — `create_user` [OAS]

- Body: `CreateUserRequest { username: string, description?: string }`.
- Responses: `201 Created` `User` / `400` `"name"` (empty username).

#### `GET /admin/api/users/:id` — `get_user` [OAS]

- Responses: `200 OK` `User` / `404`.

#### `PUT /admin/api/users/:id` — `update_user` [OAS]

- Body: `UserDataRequest { username, credential_policy?, description?, rate_limit_bytes_per_second? }`.
- Responses: `200 OK` `User` / `404`.

#### `DELETE /admin/api/users/:id` — `delete_user` [OAS]

- Also deletes the role bindings.
- Responses: `204` / `404`.

#### `GET /admin/api/users/:id/roles` — `get_user_roles` [OAS]
- `200 OK` `Role[]` / `404`.

#### `POST /admin/api/users/:id/roles/:role_id` — `add_user_role` [OAS]
- `201 Created` empty body / `409` already bound.

#### `DELETE /admin/api/users/:id/roles/:role_id` — `delete_user_role` [OAS]
- `204` / `404`.

### 2.4 User credential sub-resources

#### Passwords (`password_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/passwords` — `200 OK` `ExistingPasswordCredential[]` (only `{ id }`).
- `POST /admin/api/users/:user_id/credentials/passwords` — Body `{ password: string }` (secret — write-only), `201 Created` `ExistingPasswordCredential`.
- `DELETE /admin/api/users/:user_id/credentials/passwords/:id` — `204` / `404`.

#### Public keys (`public_key_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/public-keys` — `200 OK` `ExistingPublicKeyCredential[]`.
- `POST /admin/api/users/:user_id/credentials/public-keys` — Body `{ label, openssh_public_key }`, `201` `ExistingPublicKeyCredential`.
- `PUT /admin/api/users/:user_id/credentials/public-keys/:id` — same body, `200` / `404`.
- `DELETE /admin/api/users/:user_id/credentials/public-keys/:id` — `204` / `404`.

#### OTP (`otp_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/otp` — `200 OK` `ExistingOtpCredential[]` (`{ id }`).
- `POST /admin/api/users/:user_id/credentials/otp` — Body `{ secret_key: byte[] }` (secret — write-only), `201` `ExistingOtpCredential`.
- `DELETE /admin/api/users/:user_id/credentials/otp/:id` — when the user's last OTP is deleted, the OTP requirement is removed from the policy as well; `204` / `404`.

#### SSO (`sso_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/sso` — `200 OK` `ExistingSsoCredential[]`.
- `POST /admin/api/users/:user_id/credentials/sso` — Body `{ provider?: string | null, email: string }`, `201` `ExistingSsoCredential`.
- `PUT /admin/api/users/:user_id/credentials/sso/:id` — same body, `200` / `404`.
- `DELETE /admin/api/users/:user_id/credentials/sso/:id` — `204` / `404`.

#### Certificates (`certificate_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/certificates` — `200 OK` `ExistingCertificateCredential[]`.
- `POST /admin/api/users/:user_id/credentials/certificates` — Body `{ label, public_key_pem }`, `201` `IssuedCertificateCredential` (with `certificate_pem`, secret — one-time reveal).
- `PATCH /admin/api/users/:user_id/credentials/certificates/:id` — Body `{ label }`, `200` / `404`.
- `DELETE /admin/api/users/:user_id/credentials/certificates/:id` — writes a `CertificateRevocation` row, then deletes the credential; `204` / `404`.

#### API tokens (`api_tokens.rs`)

- `GET /admin/api/users/:user_id/api-tokens` — `200 OK` `ExistingApiToken[]`.
- `POST /admin/api/users/:user_id/api-tokens` — Body `{ label, expiry: date-time }`:
  - `201 Created` `TokenAndSecret` (`secret` — one-time reveal).
  - `400` `"expiry must be in the future"` / `"label is required"`.
- `DELETE /admin/api/users/:user_id/api-tokens/:id` — `204` / `404`.

### 2.5 Targets (`targets.rs`)

#### `GET /admin/api/targets` — `get_targets` [OAS]

- Query: `search?: string`, `group_id?: uuid`.
- Responses: `200 OK` `Target[]`. Targets bound to accounts have their inline credentials cleared entirely; targets without bound accounts keep the username and auth method and only have the secret fields cleared. `accounts` is populated, `allow_roles` holds the bound role ids (strings).

#### `POST /admin/api/targets` — `create_target` [OAS]

- Body: `TargetDataRequest`:
  - `name: string` (non-empty)
  - `description?: string`
  - `options: TargetOptions`
  - `accounts?: TargetAccountBinding[]` (`{ account_id: i32, role: "primary"|"fallback"|"readonly" }`; a non-empty list switches to account mode and clears inline credentials; an empty list `[]` means inline credentials and removes existing bindings; omitting it leaves bindings unchanged)
  - `rate_limit_bytes_per_second?: u32`
  - `group_id?: uuid`
- Responses:
  - `201 Created` `Target`.
  - `400` `"name"` (empty name).
  - `409` `"Name already exists"`.
  - `422` `"accounts cannot be mixed with inline credentials"` / `"accounts must include a primary binding"` / `"account {id} not found"` / `"account {id} kind {kind} is not compatible with target kind"`.

#### `GET /admin/api/targets/:id` — `get_target` [OAS] — `200` / `404`.

#### `PUT /admin/api/targets/:id` — `update_target` [OAS]

- Same body as create. The `kind` of `options` must match the stored record.
- In inline mode, a secret field left empty (with the auth method unchanged) keeps the stored secret, so a GET → PUT round trip does not wipe secrets.
- After the update, rate limits are reapplied and the target's DB pool is invalidated.
- Responses: `200` / `400` (kind mismatch, empty body) / `404` / `422` (as for create).

#### `DELETE /admin/api/targets/:id` — `delete_target` [OAS]

- Also deletes role bindings; for SSH targets the known-hosts entries for its host:port are removed; the target's DB pool is invalidated.
- Responses: `204` / `404`.

#### `GET /admin/api/targets/:id/known-ssh-host-keys` — `get_ssh_target_known_ssh_host_keys` [OAS]

- Responses: `200 OK` `SSHKnownHost[]` / `400` (not an SSH target) / `404`.

#### `GET /admin/api/targets/:id/upstream-certificate` — `get_target_upstream_certificate` [OAS]

- Performs one TLS handshake with an HTTP target's upstream (10 s timeout), returns its certificate chain and verifies it against the system roots plus the target's `ca_certificate`; untrusted chains are still returned.
- Responses: `200 OK` `{ tls, verify, chain: CertificateInfo[], verify_error, error }` (`tls=false`, `chain=[]` for `http://` upstreams; `error` gives the reason when the connection fails) / `400` (not an HTTP target) / `404`.
- `CertificateInfo`: `{ subject, issuer, serial, not_before, not_after, subject_alt_names, sha256_fingerprint }`, leaf first.

#### `GET /admin/api/targets/:id/roles` — `get_target_roles` [OAS] — `200` `Role[]` / `404`.
#### `POST /admin/api/targets/:id/roles/:role_id` — `add_target_role` [OAS] — `201` / `409`.
#### `DELETE /admin/api/targets/:id/roles/:role_id` — `delete_target_role` [OAS] — `204` / `404`.

### 2.6 Target groups (`target_groups.rs`)

- `GET /admin/api/target-groups` — `200 OK` `TargetGroup[]` (by name).
- `POST /admin/api/target-groups` — Body `{ name, description?, color?: BootstrapThemeColor }`: `201 Created` `TargetGroup` / `400 "name"` / `409 "Name already exists"`.
- `GET /admin/api/target-groups/:id` — `200` / `404`.
- `PUT /admin/api/target-groups/:id` — same body as create; a duplicate name returns `400`; `200` / `400` / `404`.
- `DELETE /admin/api/target-groups/:id` — sets `group_id` to NULL on targets in the group, then deletes it; `204` / `404`.

### 2.7 Roles (`roles.rs`)

- `GET /admin/api/roles` — Query `search?`; `200` `Role[]`.
- `POST /admin/api/roles` — Body `{ name, description?, allow_file_transfer? }` (`allow_file_transfer` defaults to `true`); `201` `Role` / `400 "name"`.
- `GET /admin/api/role/:id` — `200` / `404`.
- `PUT /admin/api/role/:id` — same body as create; omitting `allow_file_transfer` keeps it unchanged; the built-in admin role cannot be changed; `200` / `403` / `404`.
- `DELETE /admin/api/role/:id` — the built-in admin role cannot be deleted; `204` / `403` / `404`.
- `GET /admin/api/role/:id/targets` — `200` `Target[]` / `404`.
- `GET /admin/api/role/:id/users` — `200` `User[]` / `404`.

### 2.8 Shared accounts (`accounts.rs`)

#### `GET /admin/api/accounts` — `get_accounts` [OAS]

- Query:
  - `kind?: string`
  - `tag?: string` — substring match of `"<tag>"` against the serialized JSON tags
  - `q?: string` — substring of `name` or `description`
  - `page?: u64` (default 1, clamped ≥ 1)
  - `page_size?: u64` (default 100, clamped to 1..=500)
- Responses: `200 OK` `AccountSummary[]` (no total / offset wrapper).

#### `POST /admin/api/accounts` — `create_account` [OAS]

- Body: `AccountCreate { kind, name, description?, credentials: object, tags? }`.
- Responses:
  - `201 Created` `AccountSummary`.
  - `400` `"name is required"`.
  - `409` `"name already exists"`.
  - `422` `"credentials must be a JSON object"` / `"credentials kind \"X\" does not match account kind \"Y\""` / `"invalid credentials for kind \"X\": ..."`.

#### `GET /admin/api/accounts/:id` — `get_account` [OAS]

- Responses:
  - `200 OK` `AccountDetail` (`AccountSummary` flattened + `credentials_schema: { kind, fields: { [name]: { present, sensitive } } }`; plaintext secrets are not returned).
  - `404` / `422` (stored credentials cannot be deserialized).

#### `PUT /admin/api/accounts/:id` — `update_account` [OAS]

- Body: `AccountUpdate { name?, description?, credentials?, tags?, rotation_due_at?, clear_rotation_due_at? }`, each field independently optional; `credentials` must match the existing `kind`; `clear_rotation_due_at: true` clears the rotation date.
- Responses: `200` `AccountSummary` / `400 "name is required"` / `404` / `409 "name already exists"` / `422` (credential validation error).

#### `DELETE /admin/api/accounts/:id` — `delete_account` [OAS]

- Responses:
  - `204` deleted.
  - `404`.
  - `409` `AccountDeleteConflict { error: "account_in_use", reference_count: u32, references: AccountReference[] }`.

#### `GET /admin/api/accounts/step-up` — `get_account_step_up` [OAS]

- The step-up confirmation window of the current browser session.
- Responses: `200 OK` `{ valid_until: date-time | null }`; `null` means the next sensitive action needs confirmation (always `null` for API-token calls, which never need confirmation).

#### `POST /admin/api/accounts/:id/reveal` — `reveal_account` [OAS]

- Summary: returns the plaintext `credentials` after confirming the caller's identity and writes an audit entry (`account.credentials.reveal`, with actor, reason and confirmation factor). Only callers with a username (the shared admin token gets `401`). Rate limited to 10 per minute per caller and 5 per minute per caller + account; an OTP confirmation can be used only once per user within 120 seconds.
- Request: `RevealConfirmation { reason?: string, password?: string, otp?: string }`; `reason` is optional and at most 500 characters; exactly one of `password` and `otp` (6 digits) must be given.
- Responses:
  - `200 OK` `AccountReveal { credentials: AccountCredentials }` (all secrets — one-time reveal), with `Cache-Control: no-store`.
  - `400` the body violates the constraints above.
  - `401` no username, failed confirmation, or OTP reuse.
  - `429` rate limit exceeded.
  - `404` / `422` (stored credentials cannot be parsed).

#### `GET /admin/api/accounts/:id/references` — `get_account_references` [OAS]

- Responses: `200 OK` `AccountReference[]` / `404`.

### 2.9 Tickets (`tickets_list.rs`, `tickets_detail.rs`)

#### `GET /admin/api/tickets` — `get_tickets` [OAS]

- Responses: `200 OK` `Json<Ticket[]>` (`Ticket.secret` is `#[serde(skip)]` and never returned).

#### `POST /admin/api/tickets` — `create_ticket` [OAS]

- Body: `CreateTicketRequest { username, target_name, expiry?: date-time, number_of_uses?: i16, description? }`.
- Responses:
  - `201 Created` `TicketAndSecret { ticket: Ticket, secret: string }` (`secret` — one-time reveal).
  - `400` `Json<string>`: `"username"` or `"target_name"`.

#### `DELETE /admin/api/tickets/:id` — `delete_ticket` [OAS] — `204` / `404`.

### 2.10 SSH host keys and probing (`ssh_keys.rs`, `known_hosts_list.rs`, `known_hosts_detail.rs`, `ssh_connection_test.rs`)

- `GET /admin/api/ssh/own-keys` — `200 OK` `Json<SSHKey[]>` (`{ kind, public_key_base64 }`). The public keys of the gateway's own SSH client.
- `POST /admin/api/ssh/known-hosts` — Body `AddSshKnownHostRequest { host, port: i32, key_type, key_base64 }`; `200 OK` `Json<SSHKnownHost>`.
- `GET /admin/api/ssh/known-hosts` — `200 OK` `Json<SSHKnownHost[]>`.
- `DELETE /admin/api/ssh/known-hosts/:id` — `204` / `404`.
- `POST /admin/api/ssh/check-host-key` — Body `{ host: string, port: u16 }`; `200 OK` `{ remote_key_type, remote_key_base64 }` / `500 PlainText<string>` (human-readable error chain).

### 2.11 Logs and parameters (`logs.rs`, `parameters.rs`)

#### `POST /admin/api/logs` — `get_logs` [OAS]

- Body: `GetLogsRequest`:
  - `before?: date-time`, `after?: date-time` (with `after`, results are in ascending time order)
  - `limit?: u64` (default 100)
  - `session_id?: uuid`
  - `username?: string` — matches the log row's `username` column
  - `search?: string` — substring of `text` / `username` / `values`
  - `target_name?: string` — matches the session's `target_snapshot.name`
- Responses: `200 OK` `Json<LogEntry[]>`.
- Contains session-plane audit events only; management actions are in `/admin/api/management-audit`.

#### `POST /admin/api/management-audit` — `get_management_audit` [OAS]

- Body: same as `GetLogsRequest` (a non-empty `target_name` returns an empty array).
- Responses: `200 OK` `Json<LogEntry[]>` from the separate `management_audit` table: a `requested` and a `completed` entry for each identified management write (`values.event = "management.action"`), plus `session.delete` and `account.credentials.reveal` events.
- This endpoint and `/admin/api/logs` are read-only queries; although they use POST, they are not recorded by the management audit.

#### `GET /admin/api/parameters` — `get_parameters` [OAS]

- Responses: `200 OK` `Json<ParameterValues>`:
  - `allow_own_credential_management: bool`
  - `rate_limit_bytes_per_second?: u32` (`null` = unlimited)
  - `ssh_client_auth_publickey: bool`, `ssh_client_auth_password: bool`, `ssh_client_auth_keyboard_interactive: bool`
  - `minimize_password_login: bool`
  - `sql_console_rate_limit_per_user?: u32`, `sql_console_rate_limit_per_target?: u32`
  - `terminal_watermark_enabled: bool`
  - `site_title?: string` (`null` = the built-in title "Gated")

#### `PUT /admin/api/parameters` — `update_parameters` [OAS]

- Body `ParameterUpdate`:
  - Required: `allow_own_credential_management`
  - Always written: `rate_limit_bytes_per_second?`, `sql_console_rate_limit_per_user?`, `sql_console_rate_limit_per_target?` (`null` clears)
  - Partial (omitted = keep the old value): `ssh_client_auth_publickey?`, `ssh_client_auth_password?`, `ssh_client_auth_keyboard_interactive?`, `minimize_password_login?`, `terminal_watermark_enabled?`
  - `site_title?: string`: omitted keeps the old value; empty after trimming clears it (back to "Gated"); at most 64 characters, no control characters.
- Responses: `201 Created` (variant `Done`), empty body; `400` `Json<string>` (invalid `site_title`).

### 2.12 OpenAPI metadata

- `GET /admin/api/openapi.json`
- `GET /admin/api/playground`

### 2.13 Browser login sessions (`management_sessions.rs`)

Browser login sessions live in the in-memory management session registry, not in the `sessions` table; a restart ends all of them.

#### `GET /admin/api/management-sessions` — `get_management_sessions` [OAS]

- Responses: `200 OK` `ManagementSession[]`: `{ id: uuid, username: string, created: date-time, last_active: date-time, current: bool }`, ordered by login time; `current` marks the caller's own session. Sessions that have not finished logging in are not listed.

#### `DELETE /admin/api/management-sessions/:id` — `revoke_management_session` [OAS]

- Responses: `204` revoked, the cookie stops working on its next request; `404` not found.

### 2.14 File operation records (`file_records.rs`)

File operations from native SFTP (`origin: "sftp"`, recording name `sftp`) and the web file manager (`origin: "web"`, recording name `web-files`) are stored as `FileAudit` recordings (JSONL). Native SFTP records `read` / `write` (with byte counts), `remove`, `rename`, `mkdir`, `rmdir`, `symlink`, `setstat`; directory listings and stat are not recorded. Files still open when the channel closes are recorded as failed. When no role allows file transfer, the `sftp` subsystem request is rejected and an audit entry is written.

#### `GET /admin/api/file-records` — `get_file_records` [OAS]

- Query: `session_id? / username? / target_id? / origin? / operation? / from? / to?` (RFC 3339) `/ q?` (case-insensitive path substring) `/ limit?` (default 100) `/ offset?`.
- Responses: `200 OK` `{ items: FileRecord[], total, offset, limit }`, newest first; `400` on malformed times. `FileRecord { timestamp, session_id, target, target_id?, user_id?, username?, origin, operation, path, new_path?, bytes?, success, error? }`.

### 2.15 Update and restart (`system.rs`)

Talks to the supervisor through lode's `$LODE_DIR/state.json` (`crates/gated-core/src/lode.rs`): reads the state lode writes and writes `check_nonce` / `target` / `restart_nonce` requests (read-modify-write under `state.json.lock`, keeping lode's fields). The process counts as supervised when the `LODE_DIR` and `LODE_INSTANCE` environment variables are set; otherwise every write returns `409`.

#### `GET /admin/api/system/update` — `get_update_status` [OAS]

- Response 200: `UpdateStatus { supervised, instance?, current?, last_good?, available?, status?, last_check?, last_error?, checked_nonce, check_error? }`. With `supervised = false` the other fields are empty. `instance` changes on every start, which the UI uses to detect a finished restart.

#### `POST /admin/api/system/update/check` — `check_for_update` [OAS]

- Increments `check_nonce`. Response `202` `{ nonce }`: the check is done once `checked_nonce` reaches `nonce`; `check_error` holds the failure reason, otherwise `available` is the available version (none = up to date); `409` when not supervised.

#### `POST /admin/api/system/update` — `apply_update` [OAS]
#### `POST /admin/api/system/restart` — `restart_gateway` [OAS]

- Body `LifecycleRequest { version?, password?, otp?, reason? }`; `version` is only used for updates and defaults to `available`. Browser sessions need a step-up confirmation (as for shared accounts; not needed again within the 15-minute sliding window); API tokens need none.
- An update writes `target`, a restart increments `restart_nonce`; each writes a `system.update` / `system.restart` management audit entry.
- Responses: `202`; `400` confirmation required or no update available; `401` confirmation failed; `409` not supervised; `429` too many confirmation attempts.

### 2.16 Command control (`command_acl.rs`, `command_review.rs`, `command_records.rs`)

Off by default: with no rules everything is allowed. See `docs/design/command-control.md`.

#### `GET /admin/api/command-acl-rules` — `get_command_acl_rules` [OAS]

- Responses: `200 OK` `CommandAclRule[]`.

#### `POST /admin/api/command-acl-rules` — `create_command_acl_rule` [OAS]
#### `PUT /admin/api/command-acl-rule/:id` — `update_command_acl_rule` [OAS]

- Body `CommandAclRuleRequest { name, enabled? (default true), priority (lower is evaluated first), protocol: ssh|mysql|postgres|any, match_type: regex|keyword, pattern, action: allow|deny|review, target_id? (null = all targets), role_id? (null = all roles), description? }`.
- Responses: `201` on create and `200` on update with the `CommandAclRule`; `400` `Json<string>` (empty required field, invalid enum value or a regex that does not compile); `404` on update.

#### `GET /admin/api/command-acl-rule/:id` — `get_command_acl_rule` [OAS]
#### `DELETE /admin/api/command-acl-rule/:id` — `delete_command_acl_rule` [OAS]

- Responses: `200 OK` `CommandAclRule` / `204` deleted / `404`.

#### `GET /admin/api/command-reviews` — `get_command_reviews` [OAS]

- Commands waiting for approval (the SSH session pauses when an `action=review` rule matches).
- Responses: `200 OK` `CommandReviewItem[]`: `{ id, session_id?, user_id?, username?, target_id?, target_name, origin, command, acl_rule_id?, acl_rule_name?, requested_at }`.

#### `POST /admin/api/command-review/:id/approve` — `approve_command_review` [OAS]
#### `POST /admin/api/command-review/:id/reject` — `reject_command_review` [OAS]

- Allows or rejects the command; the paused session continues right away.
- Responses: `200` / `404` (already decided, timed out, or unknown).

#### `GET /admin/api/command-records` — `get_command_records` [OAS]

- Merges the shell command audit and the SQL audit. Query: `session_id? / user_id? / username? / target_id? / source?` (`shell`|`sql`) `/ from? / to?` (RFC 3339) `/ q?` (case-insensitive command substring) `/ limit?` (default 100) `/ offset?`.
- Responses: `200 OK` `{ items: CommandRecord[], total, offset, limit }`, newest first; shell records carry `origin`, `acl_action`, `acl_rule_id`, `acl_rule_name`, `outcome`, SQL records carry `success`, `error`. `400` on malformed times.

---

## 3. Encryption / unlock (prefix `/api/admin/encryption`)

Non-OpenAPI routes handled directly by `crates/gated-admin/src/http_service/api/encryption.rs`; they are also served by the minimal pre-unlock HTTP server. `/init` and `/unlock` share one `governor` rate limiter per client IP: **5 per minute**. Over the limit the response is `429 Too Many Requests` with `{ "code": "rate_limited", "message": "Too many attempts", "retry_after": 60 }`.

#### `GET /api/admin/encryption/lock-status` — `lock_status`

- Auth: none.
- Response 200: `{ status: "disabled" | "uninitialized" | "locked" | "unlocked" | "error", db_ready: bool, retry_after: null }`.

#### `GET /api/admin/encryption/status` — same as `lock-status` (registered alias)

#### `POST /api/admin/encryption/init` — `init`

- Auth: the bootstrap token (one-time, generated at startup and stored in the data directory); rate limited per IP.
- Body: `{ bootstrap_token: string, master_password: string }`.
- Responses:
  - `201` `{ "status": "unlocked", "plaintext_backup": string | null }`. When an existing plaintext SQLite database was migrated, `plaintext_backup` is the path of the unencrypted copy kept on the server (an `encryption_plaintext_backup_retained` audit entry is written too); delete it by hand once verified.
  - `409` `encryption_disabled` / `already_initialized` / `database_detection_failed` / `database_not_plaintext` / `init_failed`.
  - `403` `forbidden` (token mismatch or no token on the server).
  - `401` `unauthorized` (opening the encrypted DB failed after setting the DEK; the runtime is back to locked and the DB closed).
  - `429` `rate_limited` (`retry_after: 60`).

#### `POST /api/admin/encryption/unlock` — `unlock`

- Auth: the master password only; rate limited per IP.
- Body: `{ master_password: string }`.
- Responses:
  - `200` `{ "status": "unlocked" }`.
  - `409` `encryption_disabled` / `invalid_state`.
  - `401` `unauthorized` (wrong password, or opening the DB failed after unlocking).
  - `429` `rate_limited`.

#### `POST /api/admin/encryption/lock` — `lock`

- Auth: admin. `401`/`403` return an empty body.
- Responses: `200` `{ "status": "locked" }` / `409` `encryption_disabled` / `invalid_state` / `401` / `403`.

#### `POST /api/admin/encryption/rekey-master` — `rekey_master`

- Auth: admin.
- Body: `{ old_password: string, new_password: string }`.
- Responses:
  - `200` `{ "status": "unlocked" }`.
  - `409` `encryption_disabled` / `invalid_state`.
  - `401` `unauthorized` (wrong old password) / `401`/`403` (missing or non-admin authorization).

---

## 4. Observability / health (separate listener; mounted only when `metrics.enable = true`)

#### `GET /metrics` — `metrics_endpoint`

- No authentication (rely on the loopback binding / network policy).
- `200 OK` Prometheus text exposition format (`Content-Type: text/plain; version=0.0.4`).

#### `GET /healthz` — `healthz_endpoint`

- No authentication; also mounted on the main HTTP port and on the minimal pre-unlock HTTP server.
- `200 OK` with the text `ok`.

#### `GET /readyz` — `readyz_endpoint`

- Summary: runs `deep_check` (`skip_lookups: true`, so SSO probes are skipped) with a 1500 ms outer timeout.
- Status: `ok`/`warn` → `200`; `fail` → `503`.
- Body — `DeepHealthReport`:

  ```json
  {
    "status": "ok" | "warn" | "fail",
    "generated_at": "<RFC3339 UTC>",
    "checks": [
      { "name": "<id>", "status": "ok" | "warn" | "fail", "message": "<optional>" }
    ]
  }
  ```

  Built-in checks:
  - `db.ping` — `SELECT 1` within 700 ms.
  - `db.migrations` — 700 ms; pending migrations → `fail` with the message `"<N> pending migration(s): <names>"`.
  - `db.tx_roundtrip` — `BEGIN` + `COMMIT` within 700 ms.
  - `tls.cert` — parses `admin.certificate`; ok when `admin.tls = false` (`"HTTPS disabled — no cert to check"`). `< 7 days` → warn; expired / unreadable / unparseable → fail; otherwise ok (`"valid for <N> day(s)"`).
  - `deep_check` — a single synthesized fail, only when the outer timeout fires, with the message `"deep check exceeded 1500ms guard"`.

---

## 5. Static assets / SPA

- `/ui/*` — the embedded frontend (`gated-web` assets).
- `/` — top-level catchall (pre-login pages, error pages and so on).

---

## 6. Shared schemas

### 6.1 Authentication

#### `AuthStateDescription`

```
{
  id: string,                              // AuthState uuid
  protocol: string,                        // "HTTP" | "SSH" | "MySQL" | "PostgreSQL" | "Kubernetes"
  address: string | null,                  // source IP, if known
  started: date-time,
  state: ApiAuthState,
  identification_string: string            // 4 upper-case hex chars, the browser-approval confirmation code
}
```

#### `ApiAuthState`

`NotStarted | Failed | PasswordNeeded | OtpNeeded | SsoNeeded | WebUserApprovalNeeded | PublicKeyNeeded | Success`.

Selection order `PREFERRED_NEED_CRED_ORDER`: `PublicKey, Password, Totp, Sso, WebUserApproval`.

#### `LoginRequest` / `LoginFailureResponse` / `OtpLoginRequest`

- `LoginRequest { username: string, password: string }`
- `LoginFailureResponse { state: ApiAuthState }`
- `OtpLoginRequest { otp: string }`

#### `SsoProviderDescription` / `StartSsoResponseParams` / `StartSloResponseParams` / `ReturnToSsoFormData`

- `SsoProviderDescription { name: string, label: string, kind: "Google" | "Apple" | "Azure" | "Custom" }`
- `StartSsoResponseParams { url: string }`, `StartSloResponseParams { url: string }`
- `ReturnToSsoFormData { code?: string }`

#### Session cookie

Name `gated-http-session`. `Secure` = `admin.tls`; `Max-Age` = `admin.cookie_max_age`; `Domain` is `admin.cookie_domain` or the derived `.<external_host>`, stripped automatically by `CookieHostMiddleware` for localhost / bare IPs.

### 6.2 Instance / targets

#### `Info` / `PortsInfo` / `SetupState`

```
Info {
  version: string | null,                  // gated_version(); null without authentication
  username: string | null,
  admin: bool,
  selected_target: string | null,
  external_host: string | null,
  ports: PortsInfo,
  minimize_password_login: bool,
  authorized_via_ticket: bool,
  authorized_via_sso_with_single_logout: bool,
  own_credential_management_allowed: bool,
  setup_state: SetupState | null
}
PortsInfo { ssh: u16|null, http: u16|null, mysql: u16|null, postgres: u16|null, kubernetes: u16|null }
SetupState { has_targets: bool, has_users: bool }
```

#### `TargetSnapshot` / `GroupInfo`

```
TargetSnapshot {
  name: string,
  description: string,
  kind: "http" | "mysql" | "ssh" | "postgres",
  group: GroupInfo | null,
  default_database_name: string | null
}
GroupInfo { id: uuid, name: string, color: BootstrapThemeColor | null }
```

`BootstrapThemeColor` ∈ `"primary" | "secondary" | "success" | "danger" | "warning" | "info" | "light" | "dark"`.

### 6.3 Users and roles

#### `User`

```
{
  id: uuid,
  username: string,
  description: string,
  require?: UserRequireCredentialsPolicy,  // serde name "require"; the Rust field is credential_policy
  rate_limit_bytes_per_second: number | null
}
```

#### `UserRequireCredentialsPolicy`

Every protocol field is `Option<Vec<CredentialKind>>` and absent when unset:

```
{ http?: CredentialKind[], kubernetes?: CredentialKind[], ssh?: CredentialKind[],
  mysql?: CredentialKind[], postgres?: CredentialKind[] }
```

`CredentialKind` serialized values (lowercase): `"password" | "publickey" | "certificate" | "otp" | "sso" | "web"`.

#### `Role`

`{ id: uuid, name: string, description: string, allow_file_transfer: bool }`. `allow_file_transfer` controls native SFTP and the web file manager on the targets the role grants; it does not affect terminals.

### 6.4 Credentials

```
ExistingPasswordCredential       { id: uuid }
NewPasswordCredential            { password: string }                               // secret — write-only

ExistingPublicKeyCredential      { id, label, date_added?, last_used?,
                                   openssh_public_key? OR abbreviated }
NewPublicKeyCredential           { label: string, openssh_public_key: string }

ExistingOtpCredential            { id: uuid }
NewOtpCredential                 { secret_key: byte[] }                             // admin API only; secret — write-only
ConfirmOtpCredential             { otp: string }                                    // confirms the user's two-step enrollment

ExistingSsoCredential            { id: uuid, provider: string | null, email: string }
NewSsoCredential                 { provider?: string | null, email: string }

ExistingCertificateCredential    { id, label, date_added?, last_used?, fingerprint } // sha256 hex
IssueCertificateCredentialRequest{ label: string, public_key_pem: string }
IssuedCertificateCredential      { credential: ExistingCertificateCredential,
                                   certificate_pem: string }                        // secret — one-time reveal
UpdateCertificateCredential      { label: string }
```

Note: the `ExistingPublicKeyCredential` returned by the user-side `add_my_public_key` carries `abbreviated` (first 10 + `...` + last 10 characters) and not the full key; the admin API returns the version with the full `openssh_public_key`.

#### API tokens

```
ExistingApiToken { id: uuid, user_id?: uuid, label, created: date-time, expiry: date-time }
NewApiToken      { label: string, expiry: date-time }
TokenAndSecret   { token: ExistingApiToken, secret: string }                        // secret — one-time reveal
```

### 6.5 Tickets

```
Ticket {                                  // admin view; the secret field is not serialized
  id: uuid, username, description, target,
  uses_left?: int16, expiry?: date-time, created: date-time
}
CreateTicketRequest { username, target_name, expiry?, number_of_uses?: i16, description? }
TicketAndSecret     { ticket: Ticket, secret: string }                              // secret — one-time reveal

ExistingProfileTicket  { id, target, description, uses_left?, expiry?, created }
NewProfileTicket       { target_name, expiry?, number_of_uses?: i16, description? }
ProfileTicketAndSecret { ticket: ExistingProfileTicket, secret: string }            // secret — one-time reveal
```

### 6.6 Targets

#### `Target` (admin list / detail)

```
{
  id: uuid,
  name: string,
  description: string,
  allow_roles: string[],
  kind: "ssh" | "http" | "mysql" | "postgres",
  ...variant-fields-flattened,
  accounts: TargetAccountMetadata[],
  rate_limit_bytes_per_second: u32 | null,
  group_id: uuid | null
}
```

`TargetOptions` variants (flattened into the outer object by `kind`):

- `ssh` — `TargetSSHOptions { host, port: u16=22, username="root", allow_insecure_algos?: bool, auth: SSHTargetAuth }`
- `http` — `TargetHttpOptions { url, tls: Tls, ca_certificate?: secret, upstream_auth: UpstreamAuth, flavor: "generic" | "kubernetes" }`
- `mysql` — `TargetMySqlOptions { host, port: u16=3306, username="root", password?: secret, tls, default_database_name?, readonly: bool }`
- `postgres` — `TargetPostgresOptions { host, port, username, password?: secret, tls, idle_timeout?, default_database_name?, readonly }`

```
Tls            { mode: TlsMode, verify: bool }
SSHTargetAuth  { kind: "password", password: secret }
             | { kind: "publickey", private_key_pem?: secret, passphrase?: secret }
UpstreamAuth   { kind: "none" }
             | { kind: "headers", headers: { [name]: secret } }
             | { kind: "bearer_token", token: secret }
             | { kind: "client_certificate", certificate: secret, private_key: secret }
TargetAccountMetadata { account_id: i32, account_name, kind, role: "primary"|"fallback"|"readonly" }
```

Inline secrets are cleared by list/read endpoints (plaintext never leaks); without bound accounts the username and auth method are kept.

#### `TargetGroup`

`{ id: uuid, name, description, color: BootstrapThemeColor | null }`.

#### `SSHKnownHost`

`{ id: uuid, host: string, port: i32, key_type: string, key_base64: string }`.

### 6.7 Shared accounts

```
AccountSummary {
  id: i32, kind, name, description: string | null, tags: string[] | null,
  created_by: uuid | null, created_at, updated_at, last_used_at: date-time | null,
  rotation_due_at: date-time | null, reference_count: u32
}
AccountDetail = AccountSummary + { credentials_schema: { kind, fields: { [name]: { present, sensitive } } } }
AccountReference        { target_id, target_name, target_kind, role }
AccountDeleteConflict   { error: "account_in_use", reference_count: u32, references: AccountReference[] }
AccountReveal           { credentials: AccountCredentials }
```

`AccountCredentials` (discriminator `kind`, kebab-case):

- `ssh-password { username, password: secret }`
- `ssh-key { username, private_key_pem: secret, passphrase?: secret }`
- `db-password { engine: "mysql"|"postgres", username, password: secret }`
- `k8s-token { token: secret, ca_pem?: secret, namespace? }`
- `k8s-client-cert { client_certificate_pem, client_private_key_pem: secret, passphrase?: secret, ca_pem?: secret, namespace? }`
- `http-headers { headers: { name, value: secret, sensitive?: bool }[] }`

Plaintext secrets are returned only by `POST /admin/api/accounts/:id/reveal`.

### 6.8 Sessions and recordings

```
SessionSnapshot {
  id: uuid, username?: string, target?: Target | null,
  started: date-time, ended?: date-time, ticket_id?: uuid, protocol: string
}
Recording {                                // database entity; OAS name "Recording"
  id: uuid, name, started, ended?, session_id,
  kind: "Terminal" | "Traffic" | "HttpProxy" | "SqlAudit" | "CommandAudit" | "FileAudit", metadata: string
}
HttpProxyRecordingItem {
  timestamp, request_method, request_path, request_body: any,
  response_status?: u16, response_body: any
}
AsciiCast =
  Header { version, width, height, title, time }
| Output [ time: number, stream: "i"|"o"|"e", data: string ]
```

### 6.9 SQL console

```
SchemaList   { schemas: string[], default_schema?: string, readonly: bool, kind: "MySql"|"Postgres" }
TableList    { tables: { name, type: string }[] }                                    // Rust kind → "type"
ColumnList   { columns: { name, data_type, nullable, primary_key }[] }
QueryRequest { sql, limit?: i64, console_session_key?: string }
QueryResponse{
  columns: { name, type_name }[], rows: any[][],
  rows_affected: u64 | null, truncated, elapsed_ms: u64, limit: i64,
  statement_kind: "SELECT"|"SHOW"|"EXPLAIN"|"DESCRIBE"|"INSERT"|"UPDATE"|"DELETE"|"CREATE"|"ALTER"|"DROP"|"TRUNCATE"|"OTHER"|"UNKNOWN"
}
ErrorBody    { error: string }                                                       // body of every DbError
```

`DbError` HTTP statuses: `400 / 401 / 403 / 404 / 429 / 500 / 502`. `429` carries a `Retry-After` header.

### 6.10 Terminal WebSocket frames

| Opcode | Direction | Endpoints | Payload |
|---|---|---|---|
| `0x00` `MSG_TERMINAL_DATA` | both | ssh / mysql / postgres | raw bytes |
| `0x01` `MSG_RESIZE` | client → server | ssh (u32) / mysql / postgres (u16) | `{ cols, rows }` |
| `0x02` `MSG_STATUS` | server → client | all | `{ status, message, details? }` (`details` only on `connected`) |
| `0x03` `MSG_HOST_KEY_VERIFY` | both | ssh only | server → client `{ status:"host_key_verify", algorithm, key_base64, fingerprint, host, port }`; client → server `{ accepted: bool }`, 60 s timeout |

### 6.11 Other admin schemas

```
LogEntry         { id, text, values: JsonValue, timestamp, session_id, username? }
ParameterValues  { allow_own_credential_management, rate_limit_bytes_per_second?: u32,
                   ssh_client_auth_publickey, ssh_client_auth_password,
                   ssh_client_auth_keyboard_interactive, minimize_password_login,
                   sql_console_rate_limit_per_user?: u32, sql_console_rate_limit_per_target?: u32,
                   terminal_watermark_enabled, site_title?: string }
ParameterUpdate  // as above, but ssh_*, minimize_password_login, terminal_watermark_enabled and site_title may be omitted (old value kept)
SSHKey           { kind: string, public_key_base64: string }
PaginatedResponse<T> { items: T[], total: u64, offset: u64 }                         // limit is not echoed
```

### 6.12 Health checks

```
DeepHealthReport { status: "ok"|"warn"|"fail", generated_at, checks: DeepHealthCheck[] }
DeepHealthCheck  { name: string, status: "ok"|"warn"|"fail", message?: string }
```

Roll-up: any `fail` → `fail`; otherwise any `warn` → `warn`; otherwise `ok`.

<!-- BEGIN GENERATED OPERATION INDEX: bun run openapi -->

## 7. OpenAPI operation index

Generated by `bun run openapi` from the OpenAPI contracts exported from the Rust sources; do not edit by hand. CI checks it with `bun run openapi --check`. Request and response shapes are defined by `web/scripts/openapi/*.snapshot.json`.

### User API `/api`

| Method | Path | operationId | Summary |
|---|---|---|---|
| DELETE | `/api/auth/state` | `cancel_default_auth` |  |
| DELETE | `/api/profile/api-tokens/:id` | `delete_my_api_token` |  |
| DELETE | `/api/profile/credentials/certificates/:id` | `revoke_my_certificate` |  |
| DELETE | `/api/profile/credentials/otp/:id` | `delete_my_otp` |  |
| DELETE | `/api/profile/credentials/public-keys/:id` | `delete_my_public_key` |  |
| DELETE | `/api/profile/tickets/:id` | `delete_my_ticket` |  |
| GET | `/api/auth/state/:id` | `get_auth_state` |  |
| GET | `/api/auth/state` | `get_default_auth_state` |  |
| GET | `/api/auth/web-auth-requests` | `get_web_auth_requests` |  |
| GET | `/api/db/columns/:target_name` | `get_db_columns` |  |
| GET | `/api/db/schemas/:target_name` | `get_db_schemas` |  |
| GET | `/api/db/tables/:target_name` | `get_db_tables` |  |
| GET | `/api/info` | `get_info` |  |
| GET | `/api/profile/api-tokens` | `get_my_api_tokens` |  |
| GET | `/api/profile/credentials` | `get_my_credentials` |  |
| GET | `/api/profile/sessions` | `get_my_sessions` | Sessions owned by the calling user, newest first. Management HTTP |
| GET | `/api/profile/tickets` | `get_my_tickets` |  |
| GET | `/api/sftp/:target_name/list` | `sftp_list` |  |
| GET | `/api/sso/logout` | `initiate_sso_logout` |  |
| GET | `/api/sso/providers/:name/start` | `start_sso` |  |
| GET | `/api/sso/providers` | `get_sso_providers` |  |
| GET | `/api/sso/return` | `return_to_sso` |  |
| GET | `/api/targets` | `get_targets` |  |
| POST | `/api/auth/login` | `login` |  |
| POST | `/api/auth/logout` | `logout` |  |
| POST | `/api/auth/otp` | `otpLogin` |  |
| POST | `/api/auth/state/:id/approve` | `approve_auth` |  |
| POST | `/api/auth/state/:id/reject` | `reject_auth` |  |
| POST | `/api/auth/state/continue` | `continue_default_auth` | Finish a login whose remaining factor was granted out of band (web |
| POST | `/api/db/query/:target_name` | `run_db_query` |  |
| POST | `/api/profile/api-tokens` | `create_api_token` |  |
| POST | `/api/profile/credentials/certificates` | `issue_my_certificate` |  |
| POST | `/api/profile/credentials/otp/begin` | `begin_my_otp` | Start OTP enrollment. The server generates the secret, |
| POST | `/api/profile/credentials/otp` | `add_my_otp` | Confirm OTP enrollment. Requires a live code for the |
| POST | `/api/profile/credentials/password` | `change_my_password` |  |
| POST | `/api/profile/credentials/public-keys` | `add_my_public_key` |  |
| POST | `/api/profile/tickets` | `create_my_ticket` |  |
| POST | `/api/sftp/:target_name/mkdir` | `sftp_mkdir` |  |
| POST | `/api/sftp/:target_name/remove` | `sftp_remove` |  |
| POST | `/api/sftp/:target_name/rename` | `sftp_rename` |  |
| POST | `/api/sso/return` | `return_to_sso_with_form_data` |  |

### Admin API `/admin/api`

| Method | Path | operationId | Summary |
|---|---|---|---|
| DELETE | `/admin/api/accounts/:id` | `delete_account` |  |
| DELETE | `/admin/api/command-acl-rule/:id` | `delete_command_acl_rule` |  |
| DELETE | `/admin/api/management-sessions/:id` | `revoke_management_session` |  |
| DELETE | `/admin/api/role/:id` | `delete_role` |  |
| DELETE | `/admin/api/sessions/:id` | `delete_session` | Delete a session record and everything attached to it: its recording |
| DELETE | `/admin/api/sessions/closed` | `delete_closed_sessions` | Delete all ended (historical) session records and their attached |
| DELETE | `/admin/api/sessions` | `close_all_sessions` | Close every live session. Admin-only — the whole `/admin/api` nest is |
| DELETE | `/admin/api/ssh/known-hosts/:id` | `delete_ssh_known_host` |  |
| DELETE | `/admin/api/target-groups/:id` | `delete_target_group` |  |
| DELETE | `/admin/api/targets/:id/roles/:role_id` | `delete_target_role` |  |
| DELETE | `/admin/api/targets/:id` | `delete_target` |  |
| DELETE | `/admin/api/tickets/:id` | `delete_ticket` |  |
| DELETE | `/admin/api/users/:id/roles/:role_id` | `delete_user_role` |  |
| DELETE | `/admin/api/users/:id` | `delete_user` |  |
| DELETE | `/admin/api/users/:user_id/api-tokens/:id` | `delete_user_api_token` |  |
| DELETE | `/admin/api/users/:user_id/credentials/certificates/:id` | `revoke_certificate_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/otp/:id` | `delete_otp_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/passwords/:id` | `delete_password_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/public-keys/:id` | `delete_public_key_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/sso/:id` | `delete_sso_credential` |  |
| GET | `/admin/api/accounts/:id/references` | `get_account_references` |  |
| GET | `/admin/api/accounts/:id` | `get_account` |  |
| GET | `/admin/api/accounts/step-up` | `get_account_step_up` |  |
| GET | `/admin/api/accounts` | `get_accounts` |  |
| GET | `/admin/api/command-acl-rule/:id` | `get_command_acl_rule` |  |
| GET | `/admin/api/command-acl-rules` | `get_command_acl_rules` |  |
| GET | `/admin/api/command-records` | `get_command_records` | List/search command records across the shell and SQL audit streams. |
| GET | `/admin/api/command-reviews` | `get_command_reviews` |  |
| GET | `/admin/api/file-records` | `get_file_records` | List/search file operations, newest first. Filters are AND-combined; |
| GET | `/admin/api/management-sessions` | `get_management_sessions` |  |
| GET | `/admin/api/parameters` | `get_parameters` |  |
| GET | `/admin/api/recordings/:id/http-proxy` | `get_http_proxy_recording` |  |
| GET | `/admin/api/recordings/:id` | `get_recording` |  |
| GET | `/admin/api/role/:id/targets` | `get_role_targets` |  |
| GET | `/admin/api/role/:id/users` | `get_role_users` |  |
| GET | `/admin/api/role/:id` | `get_role` |  |
| GET | `/admin/api/roles` | `get_roles` |  |
| GET | `/admin/api/sessions/:id/recordings` | `get_session_recordings` |  |
| GET | `/admin/api/sessions/:id` | `get_session` |  |
| GET | `/admin/api/sessions` | `get_sessions` |  |
| GET | `/admin/api/ssh/known-hosts` | `get_ssh_known_hosts` |  |
| GET | `/admin/api/ssh/own-keys` | `get_ssh_own_keys` |  |
| GET | `/admin/api/system/update` | `get_update_status` |  |
| GET | `/admin/api/target-groups/:id` | `get_target_group` |  |
| GET | `/admin/api/target-groups` | `list_target_groups` |  |
| GET | `/admin/api/targets/:id/known-ssh-host-keys` | `get_ssh_target_known_ssh_host_keys` |  |
| GET | `/admin/api/targets/:id/roles` | `get_target_roles` |  |
| GET | `/admin/api/targets/:id/upstream-certificate` | `get_target_upstream_certificate` |  |
| GET | `/admin/api/targets/:id` | `get_target` |  |
| GET | `/admin/api/targets` | `get_targets` |  |
| GET | `/admin/api/tickets` | `get_tickets` |  |
| GET | `/admin/api/users/:id/roles` | `get_user_roles` |  |
| GET | `/admin/api/users/:id` | `get_user` |  |
| GET | `/admin/api/users/:user_id/api-tokens` | `get_user_api_tokens` |  |
| GET | `/admin/api/users/:user_id/credentials/certificates` | `get_certificate_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/otp` | `get_otp_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/passwords` | `get_password_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/public-keys` | `get_public_key_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/sso` | `get_sso_credentials` |  |
| GET | `/admin/api/users` | `get_users` |  |
| PATCH | `/admin/api/users/:user_id/credentials/certificates/:id` | `update_certificate_credential` |  |
| POST | `/admin/api/accounts/:id/reveal` | `reveal_account` |  |
| POST | `/admin/api/accounts` | `create_account` |  |
| POST | `/admin/api/command-acl-rules` | `create_command_acl_rule` |  |
| POST | `/admin/api/command-review/:id/approve` | `approve_command_review` |  |
| POST | `/admin/api/command-review/:id/reject` | `reject_command_review` |  |
| POST | `/admin/api/logs` | `get_logs` |  |
| POST | `/admin/api/management-audit` | `get_management_audit` |  |
| POST | `/admin/api/roles` | `create_role` |  |
| POST | `/admin/api/sessions/:id/close` | `close_session` | Gracefully close a live session: signal its handle so the owning |
| POST | `/admin/api/sessions/:id/terminate` | `terminate_session` | Forcibly terminate a live session. Unlike graceful `close`, which only |
| POST | `/admin/api/ssh/check-host-key` | `check_ssh_host_key` |  |
| POST | `/admin/api/ssh/known-hosts` | `add_ssh_known_host` |  |
| POST | `/admin/api/system/restart` | `restart_gateway` |  |
| POST | `/admin/api/system/update/check` | `check_for_update` |  |
| POST | `/admin/api/system/update` | `apply_update` |  |
| POST | `/admin/api/target-groups` | `create_target_group` |  |
| POST | `/admin/api/targets/:id/roles/:role_id` | `add_target_role` |  |
| POST | `/admin/api/targets` | `create_target` |  |
| POST | `/admin/api/tickets` | `create_ticket` |  |
| POST | `/admin/api/users/:id/roles/:role_id` | `add_user_role` |  |
| POST | `/admin/api/users/:user_id/api-tokens` | `create_user_api_token` |  |
| POST | `/admin/api/users/:user_id/credentials/certificates` | `issue_certificate_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/otp` | `create_otp_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/passwords` | `create_password_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/public-keys` | `create_public_key_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/sso` | `create_sso_credential` |  |
| POST | `/admin/api/users` | `create_user` |  |
| PUT | `/admin/api/accounts/:id` | `update_account` |  |
| PUT | `/admin/api/command-acl-rule/:id` | `update_command_acl_rule` |  |
| PUT | `/admin/api/parameters` | `update_parameters` |  |
| PUT | `/admin/api/role/:id` | `update_role` |  |
| PUT | `/admin/api/target-groups/:id` | `update_target_group` |  |
| PUT | `/admin/api/targets/:id` | `update_target` |  |
| PUT | `/admin/api/users/:id` | `update_user` |  |
| PUT | `/admin/api/users/:user_id/credentials/public-keys/:id` | `update_public_key_credential` |  |
| PUT | `/admin/api/users/:user_id/credentials/sso/:id` | `update_sso_credential` |  |

<!-- END GENERATED OPERATION INDEX -->
