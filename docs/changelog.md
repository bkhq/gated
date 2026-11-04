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

Release assets no longer include the CycloneDX SBOMs (still uploaded as workflow artifacts). Releases also carry `gated-linux-x64.tar.gz` and `gated-linux-arm64.tar.gz`, stable-named archives that lode can follow with `github = "bkhq/gated"`. When the `LODE_SIGNING_KEY` secret is set, the release job signs them with lode-cli v0.4.0 and uploads `<archive>.sig` sidecars.

## 2026-10-27 06:30 [progress]

Global `--data-dir` (`GATED_DATA_DIR`): gated reads `<dir>/config.yaml` and keeps the database, keys, recordings, encryption state and bootstrap token in that directory. `unattended-setup` with `--data-dir` writes paths relative to it, so the directory can be moved, and no longer needs `--data-path`. `encrypt-existing-db --data-dir` is replaced by the global option. The container images set `GATED_DATA_DIR=/data`, so their config is now `/data/config.yaml` instead of `/data/gated.yaml`. `deploy/lode` follows GitHub releases with the release signing key on lode v0.4.0.

## 2026-10-27 06:30 [pitfall]

The v0.0.2 release build failed at `cargo deny` on RUSTSEC-2026-0391 and 0395–0399 (`zstd`/`zstd-safe`, published the same day), pulled in by `mysql_common` 0.34. `mysql_common` is now 0.38 with default features off, where `zstd` is only needed for the unused `binlog` feature; the tag produced no release.

## 2026-10-27 08:10 [progress]

Cleanup pass. Removed dead code: the unused MySQL collation table, `Row` and `ColumnDefinition` decoders and packet helpers in `gated-database-protocols` (and its crate-wide `allow(dead_code)`), unused `pub` items in other crates, and unused web hooks/API helpers; web adapters named `*ToMock` are now `*ToDomain`. Completed PMA tasks and plans were removed; only the open SQLCipher exit-abort task remains. Architecture and design docs drop line-number references and were corrected against the code (mTLS is verified in the TLS handshake and matched by serial, ticket and API-token secrets are hashed, session rows are written on authentication, `admin`/`http` config sections, six recording kinds); `docs/api.md` gains the command-control, step-up, OTP enrollment, own-sessions and session terminate/delete endpoints. Integration tests default to the musl debug binary that a plain `cargo build` produces, and the SSH connection-test suite removes its temporary sshd directories.

## 2026-10-27 08:30 [progress]

Docs are bilingual: each English doc (`README.md`, `docs/api.md`, `docs/operations.md`, `docs/architecture/*`, `docs/design/*`, `docs/testing/e2e-delivery.md`) has a Simplified Chinese sibling `*.zh-CN.md` with language links at the top; PMA records and decisions stay English-only. `docs/api.md` is now English, and `bun run openapi` writes the generated operation index into both language versions. Facts corrected while translating: the HTTP proxy also accepts the API token as `?gated-token=`, web terminal and SFTP route paths, the SQL console is REST rather than WebSocket, the recording `stream` endpoint is a WebSocket, the database stores ticket and API-token digests, and committed OpenAPI snapshots are checked in CI rather than used as a fallback.

## 2026-10-28 17:35 [BUG-P2]

Two integration tests failed intermittently in CI. The MariaDB readiness checks used `docker exec mariadb -e "SELECT 1"` over the unix socket, which also succeeds against the entrypoint's temporary init server (`--skip-networking`); gated then got `Connection refused` on TCP 3306 while the real server restarted. The checks now connect over TCP. `SSH Proto > tcpip forward` started `curl` before the `-R` forward was confirmed; it now waits for the client's `remote forward success` line first.

## 2026-11-02 12:30 [BUG-P2]

Process exit after SQLCipher use could abort with `double free or corruption` (4/200 runs of the plaintext-migration test, one process each). Dropping a sqlx SQLite connection only signals its worker thread, which closes the handle and frees SQLCipher/OpenSSL state afterwards, racing the C library's exit-time cleanup. The gateway's shutdown hit the same path. After `Services::shutdown` the `run` command now waits for queued audit entries and closes the database pool, the plaintext-to-SQLCipher migration closes its connections before renaming the files, and the tests close theirs (0/400 after the fix). The nextest `ci` profile no longer retries failed tests. Closes `20261013-2332-sqlcipher-exit-abort`.

## 2026-11-02 12:30 [progress]

Versions reset to 0.0.1 for a fresh v0.0.1 release from a single-commit history.

## 2026-11-02 16:50 [BUG-P3]

Starting `gated run` before setup reported `Could not secure config: No such file or directory`, because the permission check ran before anything checked that the file exists (seen on a first start of the lode container image). A missing config file now fails with `config file <path> does not exist; create it first with setup or unattended-setup using the same --data-dir` (or `--config`).

## 2026-11-02 17:10 [progress]

`gated --data-dir <dir> run` now initializes a missing `<dir>/config.yaml` itself (admin `--admin-port`/8888, SSH `GATED_SSH_PORT`/2222, `GATED_EXTERNAL_HOST`, `GATED_ADMIN_USERNAME`, recording on), so fresh Docker and lode deployments start without a separate setup step. Without `GATED_ADMIN_PASSWORD` a random admin password is generated and printed once to stdout, bypassing the log pipeline. `--config` mode keeps the missing-config error. Test: `tests/misc/data-dir.test.ts`.

## 2026-11-02 17:40 [progress]

First-start setup also enables the HTTP proxy listener (`GATED_HTTP_PORT`, default 8443). The setup prompts and the `unattended-setup` flag called this listener "Kubernetes"; they now say HTTP proxy and the flag is `--http-port`; `--kubernetes-port` is removed.

## 2026-11-02 19:40 [decision]

Private key material and the first admin password are no longer produced on disk or by the CLI. SSH host and client keys live in a new `ssh_keys` table (migration `m00013_ssh_keys`, encrypted with the database when at-rest encryption is on); the `ssh.keys` config field, the key files and the `client-keys` command are gone. `setup`, `unattended-setup` and first-start setup write only the config and TLS certificate (`--encryption`/`GATED_ENCRYPTION` selects at-rest encryption); the generated admin password from the 17:10 entry is removed. While the database has no users, `run` issues a bootstrap token and the web UI shows a setup page after encryption init/unlock: `POST /api/admin/setup/init` (bootstrap token or `--enable-admin-token`) creates the first admin, generates the SSH keys and starts the SSH listener, and is refused once a user exists. Encryption init keeps the bootstrap token until that step. Tests: `gated-admin` `setup::tests`, `web/src/features/setup/setup-gate.test.tsx`, `tests/misc/{data-dir,encryption-lifecycle}.test.ts`; integration helpers run setup through the API and install the `tests/ssh-keys/wg` client keys.

## 2026-11-02 19:40 [BUG-P3]

`tests/e2e-docker/Dockerfile.bootstrapped` passed `--http-port` twice after the flag rename (the first occurrence was meant to be `--admin-port`).

## 2026-11-02 21:10 [decision]

First-run setup only registers the first admin account. SSH keys are managed separately under Settings → SSH (`GET /admin/api/ssh/keys`, `POST /admin/api/ssh/keys/generate`, `POST /admin/api/ssh/keys/import`): generation fills in Ed25519 and RSA keys for each kind (host, client) that has none, and import stores an OpenSSH/PKCS#8 private key (optionally passphrase-protected), replacing the stored key of the same kind and algorithm. The stored `algorithm` is the key type (`ssh-ed25519`, `ssh-rsa`). The SSH listener starts once host keys exist. Integration helpers import the `tests/ssh-keys/wg` client keys through the API instead of writing the database.

## 2026-11-02 22:30 [BUG-P1]

First start with `GATED_ENCRYPTION=true` failed with `invalid type: string "true", expected struct EncryptionConfig`: the `GATED_` environment overlay in `load_config` mapped the variable onto the `encryption` config section. The first-start/`unattended-setup --encryption` variable is renamed to `GATED_ENCRYPTION_ENABLE`, which matches no config key. Regression test: `tests/misc/data-dir.test.ts` (first run with `GATED_ENCRYPTION_ENABLE`).

## 2026-11-02 23:00 [BUG-P1]

Setup wrote `config.yaml` before the TLS certificate and validated the config in between, so a failure there (such as the `GATED_ENCRYPTION` overlay bug above) left a config without its certificate; later starts skipped first-start setup and exited with `reading TLS certificate ... No such file or directory`. Setup now writes the certificate and key before the config file, which is the "already set up" marker. Regression test: `tests/misc/data-dir.test.ts` (first start that fails after writing the config).

## 2026-11-02 23:40 [decision]

Listener TLS certificates move into the database (task `20261102-2310`). The HTTP proxy, MySQL and PostgreSQL listeners each have an independent certificate in the new `tls_certificates` table (migration `m00014_tls_certificates`, encrypted with the database when at-rest encryption is on); a self-signed certificate for `external_host` and `localhost` is generated when a listener starts without one, and the `certificate`/`key` fields of the `http`, `mysql` and `postgres` config sections are removed (development phase, no compatibility). `GET /admin/api/tls/certificates`, `POST /admin/api/tls/certificates/{listener}/generate` and `PUT /admin/api/tls/certificates/{listener}` (validates that the key matches the leaf) back a new Settings → TLS certificates tab; changes are swapped into a `ReloadableCertResolver` and apply to new connections without a restart. Only the admin listener keeps certificate files, since it serves before the database opens; `run` regenerates them when both are missing. `gated check` no longer reads MySQL/PostgreSQL certificate files. Tests: `gated-core` `tls_certificates::tests`, `gated-admin` `tls_certificates::tests`, `web/src/features/admin/config/tls-certificates-card.test.tsx`, `tests/misc/data-dir.test.ts` (proxy serves the database certificate and a regenerated one without a restart; missing admin certificate files are regenerated).

## 2026-11-03 01:30 [decision]

ACME (DNS-01) issuance for listener certificates (task `20261103-0000`). One account and DNS provider configuration (`acme_settings`, migration `m00015_acme`; Let's Encrypt or a custom directory with an optional extra CA; httpreq or acme-dns, as offered by dnsall.com) is shared by every listener; each listener stores its domains and last result in `acme_certificates`. `PUT /admin/api/tls/certificates/{listener}/acme` issues now with `instant-acme` (all challenge records published, one propagation wait, validation, finalize, httpreq cleanup) and installs the result like an import; a background task renews certificates with under 30 days left or other names every 12 hours and backs off for an hour after a failure. Importing or regenerating a certificate stops ACME for that listener. The admin listener joins the certificate API: its pair is still kept in its files but is served through a reloadable resolver, so imported, regenerated and ACME certificates apply without a restart. Settings → TLS certificates gains the ACME settings form and a per-listener ACME dialog. Tests: `gated-core` `acme::tests`, `gated-admin` `tls_certificates::tests`, web `acme-settings-card.test.tsx` and `tls-certificates-card.test.tsx`, `tests/misc/acme.test.ts` (Pebble with validation off and a mock httpreq server: wildcard + apex issuance, records published and removed, proxy and admin listeners serve the new certificates, the admin pair is written to its files).

## 2026-11-03 10:30 [decision]

Gateway-wide SSH client keys are removed (task `20261103-1000`). `ssh_keys` holds host keys only (migration `m00016_drop_ssh_client_keys` deletes client rows); `GET /admin/api/ssh/own-keys`, `KeyKind` and the `kind` field of the SSH key API are gone, and public-key auth no longer falls back to a gateway key. Target keys live in `ssh-key` accounts or the target's inline `private_key_pem`: creating or updating an `ssh-key` account accepts `generate: "ed25519" | "rsa"` to have the server create the key, rejects a private key that does not decode, and `credentials_public` exposes the derived `public_key_openssh` and `fingerprint`; the private key is shown only through the step-up reveal. Saving an SSH target with public-key auth and neither a key nor a bound account returns `422`. The profile SSH key list returns and shows the full public key and its fingerprint (`abbreviated` is removed) and copies the full key. Web: Settings → SSH shows host keys only; the account form offers upload or generation; the account view shows the public key with a copy button. Tests: `gated-admin` `accounts`, `targets`, `ssh_keys`, `credentials` unit tests, `gated-protocol-ssh` client test, web `ssh-keys-card`, `account-form-dialog`, `profile` tests, `tests/ssh/account-binding.test.ts` (generated key end to end), `tests/api/targets/create.test.ts`; integration targets authenticate with the inline `tests/ssh-keys/wg/client-ed25519` fixture key.

## 2026-11-03 11:20 [BUG-P1]

Pasted SSH private keys whose line breaks were lost (joined with spaces, on one line, indented, CR-only or with literal `\n`) failed to decode, so v0.0.3 rejected such `ssh-key` accounts with `422` and gated could not authenticate with them. `gated_common::helpers::pem::normalize_pem` re-wraps the base64 body between the BEGIN/END lines; it runs before decoding account keys (and the stored account key is saved normalized), imported host keys, and target keys at connect time, so already-stored keys work too. Tests: `helpers::pem` unit tests, `gated-admin` `ssh_key_accounts_repair_a_key_whose_line_breaks_were_lost`, `gated-protocol-ssh` client test.

## 2026-11-03 12:10 [BUG-P2]

MFA codes could not be pasted: the login page's six one-digit boxes truncated a paste to its first digit, and the MFA enrollment and step-up inputs cut a code pasted with a space (`123 456`) at six characters. The boxes now spread a pasted or autofilled code, and every OTP input keeps only the digits (`web/src/shared/lib/otp.ts`). MFA enrollment showed only the setup key; it now renders the provisioning URI as a QR code (`qrcode.react`). Tests: `login-page`, `otp-enrollment-drawer`, `step-up-dialog`, `otp` web tests.

## 2026-11-03 13:30 [decision]

Failed operations show their specific reason in a global toast (task `20261103-1215`). API: the bodiless `400` / `401` / `403` responses of the admin and profile endpoints now carry a `Json<String>` reason (status codes unchanged); MFA enrollment confirm tells "no setup in progress or it expired", "the code is wrong" and "code already used" apart (`gated_common::helpers::otp::check_totp`), and `require_admin` answers "administrator role is required". Web: `extractMessage` reads JSON-string, plain-text, `{ message }` and `{ error }` bodies (previously only `{ message }`, so most reasons showed as `HTTP <status>`); `describeError` falls back to a localized message per status; a sonner `Toaster` and the `MutationCache` / `QueryCache` handlers in `app/query-client.ts` toast every failed mutation and every query that fails without data, except expired sessions (re-login redirect) and failures marked `meta.inlineError` (sign-in, unlock, setup, step-up, master-password and password-change prompts, which stay open). Inline server-error banners in forms, dialogs and cards were removed in favour of the toast; client-side validation stays inline. Tests: `check_totp` unit test, `tests/api/authn-contract.test.ts` reason assertions, web `http`, `error-message`, `query-client` tests and the updated component tests.

## 2026-11-03 15:30 [progress]

System Settings shows more about the lode supervisor: the last version that started successfully (`last_good`) and lode's own version, commit and features, read from the `lode` object lode 0.3.0+ writes to `state.json` (`GET /system/update` field `lode`). Updating lode itself stays with the operator (`lode-cli self-update`).

## 2026-11-04 10:30 [progress]

Browser sessions slide and their lifetime is chosen by the user (task `20261104-0900`). Previously the cookie session expired `admin.cookie_max_age` (24 h) after sign-in regardless of activity, and the idle timeout was the server-wide `admin.session_max_age`. Now every request pushes the expiry forward (the cookie `Max-Age` is re-sent at most once a minute), and the idle lifetime comes from the session: the login page offers "Stay signed in" (30 min, 1 h, 4 h, 8 h, 24 h up to `cookie_max_age`, plus the configured default; remembered in the browser) and the profile page changes it for the current session. API: `PUT /api/auth/session-lifetime`, `/api/info` fields `session_lifetime` / `session_lifetime_options`, management session `expires`. Page polling counts as activity. Tests: session store unit tests, `tests/api/auth/session-lifetime.test.ts`, login and profile page tests.

## 2026-11-04 11:30 [decision]

Only user activity extends a browser session (task `20261104-0900`, reverses "polling counts as activity"): with polling counting, an open page kept a session alive forever. Requests no longer refresh the idle timestamp (`SessionStore::touch` only syncs the lifetime and purges dead sessions); `POST /api/auth/activity` (`SessionStore::mark_active`) does. The SPA reports it on route navigation (`router.subscribe('onResolved')`) and on every mutation (`MutationCache.onMutate`), throttled to once a minute (`shared/lib/session-activity.ts`). Typing in a web terminal or SQL console without navigating or saving does not count.

## 2026-11-04 12:30 [decision]

Activity is decided per request again, with an exclusion list (task `20261104-0900`): every request of a browser session extends it, except `GET` requests to the endpoints the web UI polls or refetches on push notifications (`BACKGROUND_PATHS` in `http_service/session.rs`, matched as path prefixes on segment boundaries). The SPA no longer reports mutations (they are requests); it still reports navigation via `POST /api/auth/activity`, because a navigation served from the query cache sends no request. A newly polled endpoint must be added to `BACKGROUND_PATHS`, or an open page will keep its session alive.

## 2026-11-04 14:00 [BUG-P1]

The web terminal showed "Connected" as soon as its WebSocket opened, before the gateway had signed in to the target, so a session whose key or password the target rejected looked connected until the error arrived. `deriveBannerStatus` now stays "connecting" until the server sends the `connected` status frame (after the shell is open); the WebSocket ready state no longer decides it.

## 2026-11-04 16:00 [progress]

SSH key accounts may leave the username to the target (task `20261104-1400`): `SshKeyAccountCredentials.username` defaults to empty, `validate_required_credentials` no longer requires it, and `account_credentials::apply_ssh_account` keeps the target's username (then the gated user's) when it is empty. The account form makes the field optional and the account view shows "Target's username". `ssh-password` accounts still require a username.

## 2026-11-04 16:00 [progress]

Administrators can trust SSH host keys from the web UI (task `20261104-1430`); with the default `ssh.host_key_verification = auto_reject` there was no way to add one. An "Add host key" dialog on the Known hosts page and on an SSH target's Security tab fetches the key through the gateway (`POST /admin/api/ssh/check-host-key`, which now also returns the SHA256 `fingerprint`) or takes a pasted OpenSSH / known_hosts / ssh-keyscan line, and saves it with `POST /admin/api/ssh/known-hosts`. That endpoint now answers `400` with a reason for an invalid key (was `500`) and returns the existing entry when the same key is trusted again. The terminal's unknown-key error points to both places.

## 2026-11-04 17:30 [BUG-P1]

An SSH target's "Known host keys" stayed empty long after a key was learned: the list was cached for the default 60 s `staleTime`, and a key learned by a terminal or file connection never invalidated it, so returning to the target showed the stale empty list. The target security tab, the host keys dialog and the Known hosts page now refetch whenever they are shown (`staleTime: 0`). The backend endpoint was verified to return a key immediately (`tests/api/ssh/known-hosts.test.ts`).

## 2026-11-04 17:30 [progress]

Known hosts entries open a details dialog (row click or the eye button): host, port, key type, the SHA256 fingerprint computed in the browser (`features/known-hosts/host-key-fingerprint.ts`), the full key line with copy, and the SSH targets that use that host and port.

## 2026-11-04 19:30 [progress]

Audit entries carry the context of their proxy session. `POST /admin/api/logs` returns `session` (user, target, protocol, client address, start, end) with each entry; the audit page shows user, target, protocol and client address as columns, expands every row to the session id, session times and event fields, searches all of them, and exports them all to JSONL (`fields` holds the event's own values). Pre-sign-in events such as "Host key is unknown" now show the session's user and target instead of `system`. SSH host key events log `host`, `port`, `key_type` and the `SHA256:` fingerprint, and accepting or rejecting a key is now audited.
