# Changelog

## 2026-10-13 23:21 [BUG-P0]

MySQL packet decoders panicked on truncated input (`Buf::get_*`, `advance`, `split_to`), which exits the process because the release profile aborts on panic. All decoders in `gated-database-protocols` now use checked reads and return a protocol error. Regression tests: `mysql/protocol/truncation_tests.rs`.

## 2026-10-13 23:21 [progress]

Repository audit of `9a50100` recorded as three tasks (`20261013-2315-*`). First task: decoder fix above, clippy `indexing_slicing` error in `gated-admin`, and `web/dist` ordering in the CI Integration job and `docker/Dockerfile` (which now also builds for an explicit glibc target on the pinned toolchain).

## 2026-10-13 23:38 [decision]

Lint policy moved from `Cranky.toml` to `[workspace.lints]` (`warnings = deny`, `unsafe_code = forbid`, the previous clippy denies) and every crate root carries `#![forbid(unsafe_code)]`. `rust-version` is 1.95, the same release as the pinned toolchain, so every CI job builds on the MSRV and no separate MSRV job is added. Clippy pedantic/nursery groups are not enabled.

## 2026-10-13 23:38 [progress]

CI gains formatting, typos, cargo-nextest (profile `ci`) and doctest gates, pins bun, and builds the release binary with `--locked`. `once_cell` is replaced by `std::sync::LazyLock`/`OnceLock`. `deny.toml` bans `openssl` and `native-tls` and denies unknown sources. Path remapping for release builds is now expanded by the shell; the `.cargo/config.toml` entries were literal `$HOME`/`$PWD` strings and had no effect.

## 2026-10-13 23:38 [pitfall]

`cargo deny check advisories` fails on RUSTSEC-2024-0449 (`unsafe-libyaml`, unmaintained, via `serde_yaml`); handling is pending a decision. One nextest run aborted at process exit after a passing SQLCipher test; tracked as `20261013-2332-sqlcipher-exit-abort`.

## 2026-10-13 23:55 [progress]

Shutdown now closes live sessions and waits up to ten seconds for them to deregister and for recording writers to flush (`Services::shutdown`). Before this change a SIGTERM dropped up to five seconds of buffered recording data and left recordings without an end time. Traffic recording downloads are streamed. Core dumps are disabled at startup and panics are logged through tracing.

## 2026-10-13 23:55 [decision]

Workspace migrated to edition 2024 and resolver 3 with `cargo fix --edition`. `tail_expr_drop_order` flagged 130 sites where a tail-expression temporary is now dropped before locals; they were sampled (mostly awaited futures, lock guards and database handles released earlier), not reviewed one by one. `wrap_stream` gained a precise capture bound because the new `impl Trait` capture rules tied its result to the handle lock guard. `rand`'s `gen` is called as `r#gen` until the dependency is upgraded.

## 2026-10-14 00:00 [decision]

Decision event z0ytlcaj (option B): `gated` no longer depends on `serde_yaml`. The config file is parsed by the `config` crate into a `serde_json::Value` for the legacy-key migration, and setup writes the generated config with `serde-saphyr` 2.0 (pure Rust, serializer feature only). RUSTSEC-2024-0449 is still reported because the vendored `poem` and `poem-openapi` depend on `serde_yaml`.

## 2026-10-14 00:12 [decision]

Decision event jnk3t54s: the vendored poem crates will not be patched further; poem is to be replaced. Proposed as task and plan `20261014-0012-replace-poem-with-axum`, pending approval. Until that work lands, `cargo deny check advisories` keeps failing on RUSTSEC-2024-0449.

## 2026-10-14 01:05 [progress]

The management HTTP surface (`gated-admin`: admin and user APIs, sessions, middlewares, web terminals, the SPA) and the `gated` binary's probe and pre-unlock listeners now run on axum; the OpenAPI documents come from utoipa. The proxy listener in `gated-protocol-http` is still on poem. The regenerated snapshots are OpenAPI 3.1 and differ from the previous ones in representation only (nullable optionals, unsigned integer formats, inline unions); the JSON on the wire is unchanged. `tests/xml_compatibility.rs`, which only covered the vendored poem `Xml` payload, is removed.

## 2026-10-14 01:05 [pitfall]

`Router::nest("/ui", …)` in axum 0.8 does not match `/ui/`; the request falls through to the outer fallback, which for a signed-in browser redirected to `/ui/` again. The SPA router registers `/ui/` explicitly (`http_service::spa::routes`, with a test). utoipa documents an `IntoParams` query struct only when the operation lists it in `params(...)`.

## 2026-10-14 01:20 [progress]

The HTTP/Kubernetes proxy listener (`gated-protocol-http`) runs on axum and the shared server. poem and poem-openapi are removed from every crate, together with `vendor/` and the `[patch.crates-io]` section; `Cargo.lock` no longer contains a `poem*` or `quick-xml` package and `cargo deny check` passes. The Poem section of `docs/decisions/20260913-dependency-exceptions.md` is closed.

## 2026-10-14 01:20 [pitfall]

axum's `WebSocketUpgrade::protocols` chooses the first entry of the *server's* list that the client offered, and exposes the client's list only as a sorted set. A proxy that must agree with an upstream negotiation (here `kubectl exec` over `v5.channel.k8s.io`) has to pick from the raw `Sec-WebSocket-Protocol` header in the client's order (`kubernetes::websocket::preferred_protocol`, with tests).

## 2026-10-14 03:02 [decision]

Decision event 46scm3iv: the OpenAPI documents keep utoipa's 3.1 representation (optional fields marked nullable); the regenerated snapshots are the new baseline and no post-processing is added.

## 2026-10-14 03:03 [decision]

Decision event d0eogad3: the poem replacement branch is merged into `main` and pushed. Task `20261014-0012-replace-poem-with-axum` is completed.

## 2026-10-20 23:15 [progress]

Task `20261020-2140-improve-web-ssh-terminal`: the web SSH terminal's host key prompt (`0x03`) now also carries the OpenSSH `SHA256:` fingerprint and the target `host`/`port`, and the dialog shows them with the raw public key collapsed. A known-host mismatch reports both fingerprints instead of "SSH connection failed", and an `auto_reject` rejection points to Known hosts. The terminal page has an on-screen key bar (Esc, Tab, Ctrl+C/D/Z/L, arrows) that sends input through the normal data frame, so recording and command ACLs apply unchanged.

## 2026-10-21 03:20 [progress]

Task `20261021-0228-web-sftp-file-manager`: SSH targets get a web file manager (list, upload, download, new folder, rename, delete), opened as a workspace tab from the target page and served by `/api/sftp/{target}/*` over the gateway's own SSH client. Roles have an `allow_file_transfer` switch (migration `m00012`, default `true`) enforced for the web file manager and for native `sftp` subsystem requests. File operations from both paths are recorded as `FileAudit` recordings and listed on the admin File Records page (`GET /admin/api/file-records`); native SFTP is audited by parsing the SFTP v3 stream on the subsystem channel.

## 2026-10-21 03:20 [pitfall]

File audit items are recordings, so nothing is stored when `recordings.enable` is false; only the `audit` log lines remain. The same applies to command and SQL audits.

## 2026-10-22 00:40 [progress]

`deploy/lode/Dockerfile`: a container image for running gated under lode, based on `bkhq/lode:v0.1.0-slim` (Debian 13), with `mycli`, the MariaDB `mysql` client and `psql` for the web MySQL/PostgreSQL terminals. Verified by running the release binary in the image against MariaDB 10.8 and PostgreSQL 17 test targets.

## 2026-10-22 00:40 [BUG-P2]

The web MySQL terminal failed with "No such option: --ssl-mode" when the installed `mycli` predates 1.33 (Debian 13 ships 1.31). gated now checks `mycli --help` once and falls back to `--ssl` for required TLS and no flag otherwise, like the MariaDB client path. Test: `db_terminal::tests::mycli_tls_args_follow_the_installed_version`.


## 2026-10-22 07:58 [progress]

Release 0.22.0. Web UI pass from a full UI audit: SQL console no longer crashes over plain HTTP (`crypto.randomUUID` fallback) and route errors render inside the app shell; users list shows roles and the roles API reports `builtin`; i18n-check fails on literal `t()` keys missing from the locales; sidebar trimmed with command, file and audit records merged into one Audit page; overview activity aggregated per session; shared time and short-id formatting; target detail actions collapsed into Connect plus menus; sectioned target form; denser file manager; terminal drawn edge to edge with a status bar and a keys popover; "my sessions" opens the session by id.

## 2026-10-22 18:50 [progress]

Account step-up confirmations open a sliding 15-minute window in the browser session: create, update and reveal inside it need no password/OTP and extend it; logout ends it, and window use is audited with confirmation `grace` (`GET /admin/api/accounts/step-up`). Web SSH connection failures now name the reason in the terminal status bar instead of a generic "SSH connection failed".

## 2026-10-22 19:05 [progress]

Release 0.23.0: sliding 15-minute step-up window for account create/update/reveal, web SSH failures name their reason in the terminal status bar.

## 2026-10-22 19:25 [decision]

Config sections renamed without a compatibility layer (nothing is deployed): `http` (admin UI/API listener) is now `admin`, `proxy` (HTTP reverse-proxy listener) is now `http`, and `--http-port` is now `--admin-port`. An old config file now reads its `http:` section as the HTTP-proxy listener and ignores `proxy:`, so existing files must be edited by hand.

## 2026-10-22 19:25 [BUG-P1]

Unlocking an encrypted gateway from the browser left the page on "cannot reach gateway": the pre-unlock listener reports `unlocked` and shuts down before the full server binds, and the boot gate rendered the app right away with no retry. The gate now waits for `unlocked` with `db_ready`, retries and keeps polling after a failed status fetch. Separately, a locked instance whose admin port was already taken logged the pre-unlock listener as serving and waited forever; it now exits with the bind error. Tests: `boot-gate.test.tsx`, `tests/misc/encryption-lifecycle.test.ts`. Browser-verified: bootstrap with plaintext-DB migration, unlock (wrong and correct password), lock from settings, re-unlock without restart, SSH session on the encrypted instance.

## 2026-10-22 19:25 [pitfall]

`data/encryption/meta.db` (wrapped DEK and KDF parameters) is created 0644 in a 0755 directory, while the database itself is 0600. Not changed yet.

## 2026-10-22 20:12 [progress]

Settings are grouped into tabs (General, Sessions, SSH authentication, Update, Security, About). Under lode, the Update tab checks for updates, updates to the available version and restarts the gateway through `state.json` (`gated_core::lode`, `/admin/api/system/*`, step-up confirmation, `system.update` / `system.restart` audit). About is also `/about` for every user and replaces the user menu's version footer. Session tab dots show the connection state (connected green, failed red).

## 2026-10-22 20:12 [pitfall]

A gateway restart drops every browser session (sessions are in memory), so update and restart always end on the login page; the confirmation says so. Local lode testing uses the released lode 0.1.0 binary and a signed feed served from `127.0.0.1:18900` (`.tmp/lode`, `.tmp/lode-feed`); loopback http is allowed by lode.

## 2026-10-23 21:45 [BUG]

`/` answered 404 while an encrypted instance was locked, because the pre-unlock HTTP server had no route for it. It now redirects to `/ui/` like the full server. Regression check in `tests/misc/encryption-lifecycle.test.ts`.

## 2026-10-23 22:05 [progress]

A wrong master password on the unlock page now reminds that the master password is at least 12 characters long (the minimum enforced at initialization).

## 2026-10-23 23:20 [progress]

Targets UI (task `20261023-2230-targets-session-ui`): Connect in My targets opens the terminal directly and HTTP targets show Details; the grid/table choice persists and tables are the default. Target groups moved into the admin Targets page as a Groups view (the standalone page is gone). The terminal status bar shows only the connection state; a popover holds the full message, upstream address and user, connect time and duration, session id, and the SSH host key or database TLS settings, carried by a new `details` object on the `connected` status frame.

## 2026-10-24 00:10 [progress]

Target Security tab is per protocol: SSH keeps the known host keys (users still see the short note); HTTP shows the TLS settings and the upstream certificate chain from `GET /admin/api/targets/:id/upstream-certificate` (one handshake via `gated_tls::inspect_peer_chain`, reporting why an untrusted chain fails); MySQL/PostgreSQL show the TLS mode and certificate check. Users no longer see the tab for non-SSH targets.

## 2026-10-24 00:40 [progress]

Target detail headers show the open actions as buttons: Connect plus Files (SSH) or SQL console (MySQL/PostgreSQL). The admin detail page gains Connect, so admins connect from All targets as Edit / Connect / Files; Delete stays in the more menu.

## 2026-10-24 00:50 [progress]

Tickets can be created with unlimited uses from the form (an "Unlimited" checkbox sends no `number_of_uses`); ticket lists show remaining uses as translated text. The session recording player renders at the web terminal font size (13px) and scrolls wide sessions instead of scaling the terminal to the frame width.

## 2026-10-24 01:10 [progress]

Session lists request `logged_in_only=true`, so connections that never authenticated (port scans, failed logins) no longer appear as sessions without a user or target. The rows are still written for audit; every protocol sets the username only after authentication succeeds.

## 2026-10-24 02:30 [progress]

Session rows are written when authentication succeeds instead of on connect, so failed logins and port scans no longer appear as zero-length sessions. Each failed SSH/MySQL/PostgreSQL login writes one `auth_login_rejected` audit entry (SSH: once per connection, listing the methods tried). `GET /sessions` gains `closed_only`, `protocol`, `search`, `since`, `target_id` and `username`; the past sessions tab, target detail and user drawer page on the server. The audit log loads older entries on demand and ticket lists page 20 at a time.

## 2026-10-24 16:10 [decision]

Repository history squashed into a single commit and versioning restarted at 0.0.1; the earlier v0.21.1–v0.23.0 tags and releases were removed. Installations still on 0.23.x will not see 0.0.1 as an update and need a manual reinstall.

## 2026-10-27 06:10 [progress]

Releases also carry `gated-linux-x64.tar.gz` and `gated-linux-arm64.tar.gz`, stable-named archives that lode can follow with `github = "bkhq/gated"`. When the `LODE_SIGNING_KEY` secret is set, the release job signs them with lode-cli v0.4.0 and uploads `<archive>.sig` sidecars.
