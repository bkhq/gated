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

## 2026-11-04 20:30 [progress]

The web terminal gains a settings dialog (theme presets, custom colors, font family and size with Ctrl+= / Ctrl+- / Ctrl+0, padding, scrollbar, copy-on-select, Ctrl+Shift+C / Ctrl+Shift+V), saved per browser and applied live; file upload (button or drag-and-drop, overwrite confirmation) and download by absolute path for SSH targets; connection progress and the end reason written into the terminal; and Reconnect / New connection actions once a session ends, keeping the earlier output.

## 2026-11-04 21:20 [BUG-P1]

Administrators saw every target under My targets (and in the overview, quick connect, spotlight and the SQL console route) although the gateway only lets them connect to targets their roles grant, so connecting failed. These views now list exactly what `GET /api/targets` returns for the user (`useMyTargets`); admin pages keep the full catalogue.

## 2026-11-04 21:20 [BUG-P2]

A locked gateway answers every API except encryption with 404, which flooded an open page with error toasts. A 404 or connection failure now first checks the lock status (one request shared by all failures); while the gateway is locked, uninitialised or starting no toast is shown and the boot gate moves to the unlock screen.

## 2026-11-04 23:30 [progress]

A target can sign in with a different bound account per role. An admin picks the account for each role on the target's permissions tab; connections use the account of the role that granted access, and when the user's roles lead to several accounts the user picks one: `<user>:<target>:<account>` for native SSH, MySQL and PostgreSQL clients, a picker before the web terminal, file manager or SQL console connects. The choice is audited as `Target account selected`. HTTP targets keep the default login.

## 2026-11-04 23:30 [pitfall]

The MySQL integration tests failed with `Plugin mysql_clear_password could not be loaded` because the local MariaDB client shim looked for plugins in a system path that no longer exists; the shim in `.tmp/bin/mysql` now passes `--plugin-dir`. On the gateway side this surfaced only as `expected NUL in byte sequence`.

## 2026-11-04 23:50 [BUG-P2]

Web terminals stayed at 80x24 on the remote side (`ps -ef` and other output cut at column 80) until the browser window was resized: the first fit ran before the socket opened, the gateway ignores resizes before the session is connected, and xterm only reports size changes. The terminal now sends its size when each connection is established.

## 2026-11-05 00:20 [BUG-P2]

The bottom row of the web terminal was cut off. The terminal padding sat on the element xterm is opened in, and FitAddon reads that element's border-box height, so it fitted one row more than fits. The padding now sits on a wrapper. Browser sessions stay in memory, so a restart still signs everyone out; that behaviour is kept on purpose.

## 2026-11-05 02:30 [progress]

Targets record whether they are reachable. The gateway opens a TCP connection to each target's service port (3 s timeout, 16 at once) and stores the last result; it checks every target automatically, daily by default (`target_check_interval_hours` on the settings page, 0 turns it off), and admins can check selected, filtered or all targets from the target list. Both target lists show the status (users read-only), are paged at 50 per page, and the admin list shows totals by status and filters by it.

## 2026-11-08 10:00 [BUG-P2]

Target names and addresses kept surrounding whitespace, so a host pasted with a trailing space failed every connection and a name of only spaces was accepted. Creating or updating a target now trims the name and the host or URL; a name that is empty after trimming is refused. Targets already stored with such whitespace are corrected the next time they are saved.

## 2026-11-08 11:30 [progress]

Web file manager reworked after `bkhq/filemanager`: folder tree, sortable list with multi-select and keyboard control, filter, context menus, details panel, floating upload panel with per-file cancel, bulk download and delete. Text (up to 1 MiB) and image (up to 20 MiB) previews use the download endpoint, so each preview is audited as a download. No backend change.

## 2026-11-11 12:40 [BUG-P1]

A registered SSH public key was asked for a password and an OTP once the user enrolled OTP: `upgrade_to_otp` set the SSH policy to `[Password, Totp]`, which a key could never satisfy. A valid key now satisfies the SSH policy on its own unless the policy names `PublicKey`. Keys registered from the credentials page kept their comment and never matched; stored keys are compared as `<type> <base64>` and new ones are normalised.

## 2026-11-11 12:40 [progress]

Tickets are handed over from a dialog shown once after creation, on the user and the admin page: claim link, command line (`ticket-<secret>` user) and the secret. The link is `/ui/ticket#<secret>`; the page posts the secret to the new `POST /api/tickets/claim`, which signs the session in and consumes one use, so previewing the link no longer burns a ticket and a dead link explains itself instead of showing the login page. Ticket sessions see only the pages they can use. The admin row menu's "copy claim link" copied a link that never worked and is gone.

## 2026-11-11 14:30 [progress]

The embedded SQLCipher moves to 4.20.0 on SQLite 3.54.1 (`libsqlite3-sys` 0.40), closing RUSTSEC-2026-0459 (CVE-2026-119375) without an advisory ignore. Every sqlx release caps `libsqlite3-sys` below 0.40, so sqlx 0.8.6 is vendored under `third/sqlx` with that one bound raised and applied through `[patch.crates-io]`; `third/README.md` records the origin and the condition for removing it. `deny.toml` allows the `blessing` and `WTFPL` licenses that `sqlcipher-src` declares.

## 2026-11-11 17:30 [progress]

`rustix` moves from 1.1.4 to 1.1.6 (via `tempfile` / `dialoguer`), closing RUSTSEC-2026-0486, which cargo-deny started rejecting in the `v0.0.11` build minutes after the tag was pushed. Lockfile-only change; the tag is moved to this commit.

## 2026-11-11 16:00 [BUG-P0]

The web MySQL/PostgreSQL terminals ran `mycli` / `mysql` / `psql` on the gateway host with the target password in the environment; the clients' shell escapes gave any user with a database target command execution as the gateway user. The endpoints `/api/mysql/terminal/:target` and `/api/postgres/terminal/:target`, the PTY bridge and the `portable-pty` dependency are removed. Database targets open in the SQL console; `/ui/terminal/{mysql,postgres}/:target` redirects there and a claimed database ticket lands on it. The lode image no longer installs the database clients.

## 2026-11-11 16:00 [decision]

Adding an SSH public key from a browser session now confirms the user's identity (owner decision, 2026-11-11): the OTP when one is enrolled, otherwise the password; SSO-only users and API tokens are not asked. A key signs in to SSH on its own, so a stolen password alone could otherwise register a key and skip a required OTP. The confirmation is per request, without the 15-minute window used for shared accounts.

## 2026-11-11 17:00 [BUG-P1]

A ticket session could read and change the account behind it: `/api/profile/*` (API tokens, tickets, sessions, credential listing) accepted it, so a single-target ticket could mint a full API token. Those routers now answer `403` to ticket sessions (`forbid_ticket_sessions`). `POST /api/profile/api-tokens` rejects an `expiry` that is not in the future with `400`.

## 2026-11-11 17:00 [BUG-P1]

Ticket sessions outlived their ticket and were invisible to administrators. A ticket session now registers a management session handle, so it is listed and revocable with the browser sessions, and carries its ticket id: every request checks that the ticket still exists and has not expired, and an open web terminal rechecks every 10 seconds. A session opened with a ticket's last use stays valid until the ticket is deleted or expires.

## 2026-11-11 17:00 [BUG-P1]

The keyed login, OTP, ticket-claim, setup and unlock rate limiters grew without bound under a spray of distinct keys. They are capped at 50,000 keys (stale keys are dropped first; a full limiter refuses new keys), login rejects usernames longer than 256 bytes before any lookup, and database unlock attempts run one at a time.

## 2026-11-11 17:00 [BUG-P1]

A web terminal session that ended within 2 seconds was deleted together with its recording, so a quick command left no audit trail. Only sessions that received no input are discarded now.

## 2026-11-11 17:00 [pitfall]

Integration tests that start `gated-e2e-ssh-server` publish its port on the Docker host, which is not reachable from inside the `station` container; `tests/ssh/*` cannot run there. `/api/targets` requires a session cookie or `X-Gated-Token` (`AnySecurityScheme`), so it cannot probe a header ticket; the ticket tests probe `/api/profile/tickets` and read `403` as "authenticated".

## 2026-11-11 17:40 [BUG-P2]

The HTTP proxy forwarded `?gated-token=` / `?gated-ticket=` to the upstream application along with the rest of the query string, so an account-wide API token reached upstream access logs and the request recording. `construct_target_url` now drops `SECRET_QUERY_PARAMS`.

## 2026-11-11 17:40 [BUG-P2]

The admin WebSockets (`/admin/api/recordings/{id}/stream`, `/admin/api/sessions/changes`, `/admin/api/sessions/{id}/monitor`) upgraded for any `Origin`, and the user ones trusted every subdomain of the external host, including proxied target hosts. One middleware, `ws_origin_guard`, now checks every cookie-authenticated upgrade: request host or external host only, subdomains only under a configured `admin.cookie_domain`, never a host under `http.base_domain`. Token-authenticated upgrades are not checked, since a browser cannot attach the token header cross-site.

## 2026-11-11 18:00 [BUG-P2]

`POST /admin/api/tickets` stored any user name, target name, expiry and use count. It now answers `400` for an unknown user or target, a user without a role on the target, an `expiry` that is not in the future and a `number_of_uses` below 1. The rule is recorded in `docs/architecture/auth.md`: a ticket narrows the user's access and never replaces the user's own grant, so `revalidate_sessions` closing a ticket session whose user lost the grant is intended.

## 2026-11-11 18:30 [BUG-P2]

The SQL console returned a connection to the shared per-target pool after running user SQL, so an open `BEGIN`, `SET search_path`, `SET ROLE`, `USE`, session variables and temporary tables reached whoever got the connection next. A connection that ran user SQL is now closed instead of reused (`close_on_drop`); schema browsing still uses pooled connections.

## 2026-11-11 19:30 [BUG-P1]

A database target's `readonly` flag was enforced only in the SQL console; the native MySQL and PostgreSQL proxies forwarded writes. The proxies now keep the upstream session in read-only transaction mode and refuse the statements that would leave it (`escapes_readonly_session`). The validator moved to `gated_core::sql_validation` and lexes per engine: backslash escapes and `#` comments for MySQL, `E'...'` and dollar quotes for PostgreSQL only, and `--` needs trailing whitespace in MySQL. The old shared lexer let `SELECT '\' ; DELETE ...` hide a second statement from the PostgreSQL console check.

## 2026-11-11 19:30 [decision]

Read-only database targets remain a guard-rail, not a privilege boundary: dynamic SQL inside server-side functions and PostgreSQL functions with side effects (`dblink_exec`, `lo_import` outside the blocklist) are not stopped. `docs/api.md` states the limit and recommends a read-only upstream account.

## 2026-11-11 19:30 [pitfall]

MariaDB in read-only transaction mode still executes `SET GLOBAL ...` and `SELECT ... INTO OUTFILE`; both are refused by the proxy guard instead. The `mysql` and `psql` clients are not installed in the `station` container, so `tests/db/readonly-native.test.ts` runs the client inside the upstream database container and connects back to the gateway by hostname.

## 2026-11-11 20:10 [BUG-P2]

Only the web login limited password guessing; SSH, MySQL and PostgreSQL accepted attempts without bound, and a known password left the six-digit OTP open to brute force over SSH keyboard-interactive. `gated_core::auth_throttle` now counts failed password and OTP attempts from every listener in one bounded table (5-minute window: 10 per user and address, 60 per address, 100 per user, 10 OTP failures per user) and refuses further attempts as a wrong credential. `get_allowed_auth_methods` logged "Enabling all methods as fallback" while denying every method; the message now says so.

## 2026-11-11 20:10 [decision]

The per-user password counter is set high (100) and the tight one is per user and address (10), so a remote party cannot lock a user out of every address with a handful of failures. Not done in this change: a refused attempt on the MySQL and PostgreSQL listeners still allocates an auth state for ten minutes.

## 2026-11-11 21:00 [BUG-P2]

Argon2 verification for every password attempt ran on an async worker while holding the global `Mutex<ConfigProviderEnum>`, so failing logins delayed authorization on every listener. `gated_core::auth_throttle::validate_credential` reads the hashes under the lock and verifies them in `spawn_blocking` outside it; SSH, MySQL, PostgreSQL, the web login, the password change and the step-up check use it. `ConfigProvider` gains `get_user` and `get_target`, replacing the `list_users()` / `list_targets()` scans in `AuthStateStore::create`, the HTTP proxy resolver, the three native proxies, the web terminal and the SQL console. `tests/http/auth-contention.test.ts` measures token-authenticated requests during 40 concurrent failing logins (median stayed under the 3 ms baseline here); it was not run against the previous binary.

## 2026-11-11 21:00 [pitfall]

Running `bun test http/ api/ ...` with all files at once on the shared development host produced `database is locked` (SQLite code 5) during gateway start-up in two files; both pass when run alone.

## 2026-11-11 21:30 [progress]

Minor audit hardening: an unknown ticket secret is no longer written to the log; the MySQL and PostgreSQL proxies log statement length at info and the text only at debug (the statement is still in the session's SQL audit recording); `login_error` in the SSO redirect is percent-encoded; `POST /api/profile/credentials/password` counts wrong current passwords in the shared failed-login throttle; `DbLockMiddleware` is documented as answering 423. Declined or open items are listed in the task `20261111-1425-audit-minor-hardening`.

## 2026-11-11 22:00 [progress]

`GET /admin/api/command-records` and `/admin/api/file-records` parsed every audit recording on disk for each request. The `from` / `to` bounds are now applied to the recording rows first (`overlapping`: started before `to`, still open or ended after `from`), so only recordings that can hold an item in range are opened, and both admin pages start on the last 7 days instead of "any time" unless they are scoped to one session. `total` stays exact. Choosing "any time" still reads the whole history; removing that cost needs the records indexed in the database, which is not part of this change.

## 2026-11-11 22:30 [BUG-P1]

Command ACL was skipped on three paths: the web SSH terminal, the SQL console and a native SSH shell without a PTY (`ssh -T`). A command denied over native SSH or the database proxies ran there unrecorded. The non-PTY shell is now filtered like a PTY shell; the web terminal rebuilds lines from its input, records them (`origin: web`) and ends the terminal on `deny` or `review`; the SQL console evaluates the rules before running a statement and answers `403`. `docs/design/command-control.md` lists the coverage per path, what stays best effort, and that the file transfer permission covers only the `sftp` subsystem. Plan: `20261111-2200-command-control-coverage`.

## 2026-11-11 22:30 [pitfall]

Only the SQL console part of this change was verified end to end. `tests/ssh/acl-filter.test.ts` (non-PTY shell) and `tests/ssh/web-terminal-revocation.test.ts` (web terminal deny, short session kept) could not run in the `station` container: the SSH test server's published port is unreachable from it and `sshpass` is not installed.

## 2026-11-11 23:00 [BUG-P2]

A user's sessions survived an administrator resetting or removing their credentials, removing the `admin` role, and renaming or deleting the user; a user or target created later under the same name inherited the old sessions and tickets. These changes now end the user's browser sessions and close their proxy sessions (matched by user id; a credential change keeps the session that made it). Tickets are deleted with their user or target and follow a rename. The session identifier is replaced at sign-in. Plan: `20261111-2300-session-revocation-on-identity-change`.

## 2026-11-11 23:00 [decision]

Tickets keep naming their user and target instead of gaining id columns. Rename and delete update or remove the tickets in the same request, which closes the re-binding without a migration or a ticket API change.

## 2026-11-12 13:00 [progress]

Sessions opened with a ticket now record it: `sessions.ticket_id` was in the schema but never written. The SSH, MySQL and PostgreSQL ticket logins, the web terminal, the file manager and browser sessions set it; the admin sessions page marks these sessions, filters by sign-in kind (`via_ticket`) and can be scoped to one ticket (`ticket_id`, "View sessions" on a ticket). A ticket's secret can be rotated by its owner or an administrator (`POST .../tickets/{id}/rotate`): the old secret stops working, the sessions opened with it end, and the new secret is shown once. Plan: `20261112-1300-ticket-sessions-and-rotation`.

## 2026-11-12 13:00 [BUG-P2]

A web UI page left idle kept looking signed in after its session had expired on the gateway. The UI now asks `GET /api/auth/session` once a minute and when the tab becomes visible; the request does not count as activity, and the page returns to the login screen once the session is gone.

## 2026-11-12 13:00 [progress]

The SSH public key list shows the key type and fingerprint instead of the whole public key, and "Never used" instead of an untranslated placeholder.

## 2026-11-12 13:20 [BUG-P1]

An SSH target that presented a host key of another type than its trusted key was treated as an unknown host instead of a mismatch: `KnownHosts::validate` looked up trusted keys by key type. The lookup now uses host and port only, so any untrusted key on a host with a trusted key fails the connection. Task `20261112-1254-known-host-key-type-switch`; test `known_hosts::tests::key_of_another_type_is_a_mismatch`.

## 2026-11-12 15:30 [decision]

Plan `20261112-1301-rdp-vnc-web-desktop` approved with three owner decisions: browser access only (no native RDP/VNC listeners), keystroke recording off by default and enabled per target, and a separate role switch `allow_clipboard` for the desktop clipboard.

## 2026-11-12 15:30 [progress]

RDP/VNC step 1: the IronRDP client crates and `vnc-rs` build on the pinned toolchain without `openssl`, `native-tls`, `ring` or a vendored crate. Two `deny.toml` exceptions are needed before they join the workspace (`Unlicense` for `async_io_stream`, RUSTSEC-2026-0441 for `pin-utils`); see `docs/decisions/20261112-rdp-vnc-dependencies.md`. Step 2, first half: `gated-core` gains `protocols/desktop.rs` (protocol-neutral desktop events and input, size cap, connect and handshake deadlines, user-facing error reasons) and `protocols/framebuffer.rs` (bounds-checked compositing, PNG snapshots), ported from upstream without the interactive-logon state. The desktop recorder is not ported yet.

## 2026-11-12 15:30 [pitfall]

`cargo deny check advisories` fails on `main` on RUSTSEC-2026-0495 (`russh` 0.63.3, fixed in 0.65.0). Tracked as `20261112-1530-russh-agent-confirm-advisory`. Resolving the new `png` / `zune-jpeg` dependencies also rewrote the `windows-sys` references of nine existing packages in `Cargo.lock` to 0.61.2.

## 2026-11-12 16:30 [decision]

Owner accepted the two `deny.toml` exceptions for the RDP/VNC crates (`Unlicense` for `async_io_stream`, RUSTSEC-2026-0441 for `pin-utils`). Writing our own replacement for the `pin-utils` path was rejected: the crate is reached only through `sspi` on macOS/iOS and is never built into the Linux binaries; see `docs/decisions/20261112-rdp-vnc-dependencies.md`.

## 2026-11-12 16:30 [progress]

RDP/VNC step 2 done: `RecordingKind::Desktop` and `gated-core/src/recordings/desktop.rs`. A desktop recording is one NDJSON file (resizes, PNG/JPEG rectangles, copy operations, viewer input) with a sidecar `<name>.index` that lists keyframe byte offsets, resizes, input timestamps and the end time, opened by `SessionRecordings::start_desktop` and deleted with the recording. Raw frames are composited and encoded at most 30 times a second; a full-frame keyframe is written every 10 seconds or 2 MB. Keystrokes are recorded only after `set_record_keyboard(true)`. Tests: `recordings::desktop::tests`. The OpenAPI snapshots do not yet list the new recording kind; they are regenerated with the target API change in step 3.

## 2026-11-12 17:00 [progress]

`russh` 0.63.3 -> 0.65.1 for RUSTSEC-2026-0495 (the agent server signed with confirm-constrained keys without asking). Gated does not use the russh agent server, so it was not exposed; the upgrade clears `cargo deny check advisories`. API change: `auth_publickey_offered` and `auth_publickey` receive `PublicKeyOffer` / `VerifiedPublicKey` instead of a key reference; the handler passes on their `public_key`, so behaviour is unchanged. Verified with the workspace unit tests, clippy and `cargo deny check`; the SSH integration suite was not run (the SSH test server is unreachable from the `station` container). Task `20261112-1530-russh-agent-confirm-advisory`.

## 2026-11-12 19:00 [progress]

Security plan `20261112-1411-port-upstream-security-measures`, stage A done (six fixes ported from upstream):

- A1: `POST /api/profile/api-tokens` answers `403` to a request authenticated by an API token, so a leaked token cannot mint its replacement. Test `tests/http/api-tokens.test.ts`.
- A2: `PostgresStream::upgrade` fails when plaintext bytes are already buffered, in both directions; they were decoded after the handshake as if they had arrived through TLS.
- A3: the MySQL handshake trace logs only `database` and `auth_plugin`, not the username (possibly a ticket secret) or the auth response.
- A4: `gated-sso` rejects discovery documents whose endpoints are not `http` or `https` (`SsoError::UnsupportedEndpointScheme`).
- A5: the SSH Ctrl-C abort of a connecting session applies only to channels with a PTY, not to forwarded data that starts with `0x03`.
- A6: `Content-Security-Policy` on the management plane (`default-src 'self'`, no inline script, `frame-ancestors 'none'`). The SSO redirect page uses a `refresh` meta tag instead of an inline script; the API playground has its own relaxed policy. Checked in a browser: 23 pages of the built UI load signed in without a violation. Not exercised in that check: a live terminal, the SQL console, file previews, recording playback, the SSO redirect page, the playground.

The OpenAPI snapshots and generated types were regenerated; they now include the `Desktop` recording kind, and `admin-session-detail-page.tsx` handles it in its two `switch` statements.

## 2026-11-12 20:30 [progress]

Security plan stage B, B1 login protection done. Failed password and OTP attempts from every listener are stored in the database (`failed_login_attempts`) and lead to address blocks (`ip_blocks`, doubling for repeat offenders) and user lockouts (`user_lockouts`); migration `m00019_login_protection`, logic in `gated-core/src/login_protection.rs`, called from `auth_throttle::validate_credential_throttled`, which now takes `&Services`. Thresholds are in `parameters` (`login_protection` in the parameters API), on by default. Admin API `/admin/api/login-protection/{ip-blocks,user-lockouts}` and Settings > Security list and lift them; `gated recover-access` lifts the chosen user's lockout and all address blocks. Tests: `login_protection::tests`, `tests/http/login-protection.test.ts`, `login-protection-card.test.tsx`; the settings tab was exercised in a browser.

## 2026-11-12 20:30 [decision]

B1 differs from upstream in these points:

- The in-memory limits of `auth_throttle` stay in front of the database layer instead of being replaced: they bound the work per attempt and still limit administrators, who are exempt from lockout.
- An address is blocked after 20 failures, not upstream's 5: every user behind one NAT address shares the count.
- A successful sign-in does not clear earlier failures. Clearing on a valid password would let someone who holds the password reset the count between OTP guesses.
- Public key offers are not counted; SSH clients offer several keys before they ask for a password.
- No in-memory cache of blocks; a sign-in attempt reads two indexed rows.
- With trusted `X-Forwarded-For`, the block key is the last entry of the header, the one the nearest proxy appended. `get_client_ip` still logs the whole header.

## 2026-11-12 20:30 [pitfall]

The web login answers an unknown user name before any credential is validated, and the native listeners fail in `AuthStateStore::create`, so those attempts never reached `validate_credential_throttled`. Each listener now reports them through `auth_throttle::report_unknown_user`. Found by the integration test, not by the unit tests.

## 2026-11-12 21:00 [progress]

Security plan stage B, B5 token limits done. `parameters.max_api_token_duration_seconds` (migration `m00020_max_api_token_duration`; `null` = no limit) bounds the expiry of tokens users create through `POST /api/profile/api-tokens`; `/api/info` reports it and the create dialogs offer only lifetimes within it; Settings > General edits it in days. The config list `admin.user_api_token_allowed_endpoints` (`"<METHOD> <path>"`, trailing `*` = prefix) limits what a user API token may call on the management listener; other calls get `403` and an `api_token_endpoint_denied` audit event. `config-schema.json` regenerated. Tests: `tests/http/api-tokens.test.ts`, `tests/http/api-token-endpoints.test.ts`, `config::user_api_token_endpoint_tests`, `expiry-options.test.ts`.

## 2026-11-12 21:00 [decision]

B5 differs from the plan and upstream in two points: the list is `admin.user_api_token_allowed_endpoints`, not `http.…`, because in Gated the `http` section is the reverse-proxy listener and the API is served by `admin`; and an entry may end in `*` to match a path prefix, since exact matching cannot name endpoints with an id in the path. As upstream, the lifetime limit does not apply to tokens an administrator creates for a user.

## 2026-11-12 21:40 [progress]

Security plan stage B, B2 password policy done. `parameters` holds a minimum length and four required character classes (migration `m00021_password_policy`; default: no requirement). `PasswordPolicy::violation` (`gated-common/src/helpers/password_policy.rs`) is applied by `POST /admin/api/users/:id/credentials/passwords` and `POST /api/profile/credentials/password`, which answer `400` naming what is missing. `GET /api/profile/credentials` returns the policy; the password drawers check against it and show it, the admin reset dialog shows it, and Settings > Security edits it. Tests: `password_policy::tests`, `tests/http/password-policy.test.ts`, `password-policy.test.ts`, `profile-password.test.tsx`.

## 2026-11-12 21:40 [pitfall]

The profile password drawers enforced a hardcoded rule in the browser only (12 characters, upper, lower, digit) and the UI described it as the policy, while the server accepted any password. The drawers now apply the server's policy; with the default (no requirement) they accept what the server accepts.

## 2026-11-12 21:40 [decision]

B2: the policy binds passwords set through the admin and profile APIs. The host commands `setup`, `create-user` and `recover-access` are not bound: at first setup no policy exists yet, and the other two are run by someone who already controls the host. Existing passwords are not rechecked.

## 2026-11-12 22:30 [progress]

Security plan stage B, B4 allowed address ranges done. `users.allowed_ip_ranges` (migration `m00022_user_allowed_ip_ranges`, JSON list, `null` = anywhere) limits a user to IP addresses and CIDR ranges. It is checked in `AuthStateStore::create` (interactive sign-in on every listener, web login, SSO), in `authorize_ticket` (tickets on every listener) and after `validate_api_token` (management API and HTTP proxy); each of these now receives the client address. A refusal is answered like an unknown user, ticket or token. `PUT /admin/api/users/:id` validates and stores the list, the user dialog edits it. Tests: `helpers::ip_ranges::tests`, `tests/http/allowed-ip-ranges.test.ts`, `use-users-queries.test.ts`.

## 2026-11-12 22:30 [decision]

B4: with a list set, a request whose client address cannot be determined is refused. Upstream allows it; refusing is the safer reading of a restriction. An existing browser session is not rechecked on later requests.

## 2026-11-12 22:30 [pitfall]

`PUT /admin/api/users/:id` replaces the whole user record, and the web hook rebuilds the body from the stored user. A new user column that the hook does not copy is wiped by the next save from the UI; `userPatchToDataRequest` now sends `allowed_ip_ranges` back, with a test.

## 2026-11-12 22:40 [progress]

Security plan stage B, B3 required MFA done. `parameters.mfa_required` (migration `m00023_mfa_required`, off by default) makes an OTP device mandatory for every user, SSO users included. `ConfigProvider::mfa_setup_required` (switch on, no device) drives four checks: `inject_request_authorization` answers `403` + `X-Gated-Mfa-Setup-Required: 1` to sessions and user API tokens outside the allow-list `mfa_setup_allows`; `AuthStateStore::create` refuses every protocol but the web sign-in; the HTTP proxy refuses tokens and certificates; `/api/info` reports `mfa_setup_required`. For an enrolled user `get_credential_policy` wraps the stored policy in `RequiredFactorPolicy` so the web sign-in always needs a code. The two enrollment calls work with self-service credential management off; the last device cannot be removed by the user. Web: `MfaSetupPage` replaces the shell while enrollment is due, Settings > Security has the switch. Tests: `auth_state_store::mfa_tests`, `policy::tests::required_factor_*`, `mfa_setup_opens_only_pages_sign_in_and_enrollment`, `tests/http/mfa-enforcement.test.ts`, `tests/ssh/mfa-enforcement.test.ts`, `mfa-setup-page.test.tsx`, `layout.test.tsx`, `http.test.ts`; flow checked in a browser.

## 2026-11-12 22:40 [decision]

B3 is one switch, not upstream's `off / enroll / require`. Upstream's `require` forces in-browser approval on the database protocols; Gated's MySQL listener has no in-browser approval, so that mode would close it. After enrollment the second factor is therefore enforced at web sign-in only: SSH follows the stored policy (a registered public key still signs in alone) and the database protocols have none. User API tokens are gated like sessions; ticket sessions and the admin token are not. `gated recover-access` removes the OTP devices of the recovered user when the switch is on, because no stored policy can waive the device any more.

## 2026-11-12 22:40 [pitfall]

The SSH integration tests cannot run in the `station` sandbox: `startSshServer` publishes the test sshd with `docker run -p`, which binds on the host, not where the test process looks for it. `tests/ssh/mfa-enforcement.test.ts` is therefore unverified here; the refusal is covered by `auth_state_store::mfa_tests`. A request that carries both a session cookie and the admin token is authorized as the session, so it is gated like the session.

## 2026-11-12 22:50 [progress]

Security plan stage B, B6 role assignment expiry done; stage B is complete. `user_roles.expires_at` (migration `m00024_user_role_expiry`, `null` = never). Every read of a user's roles goes through `User::Model::active_roles` or `UserRoleAssignment::unexpired`: `authorize_target`, `authorize_file_transfer`, account resolution, `load_user_role_ids`, `is_user_admin`, the login-protection admin check and the role names of the user list. `PUT /admin/api/users/:id/roles/:role_id` sets or clears the expiry; `GET /admin/api/users/:id/roles` returns `UserRole` (`Role` + `expires_at`). `watch_role_expiry` checks every 15 seconds and triggers `Services::revalidate_sessions`. The user dialog has an expiry input per assigned role and marks expired ones. Tests: `services::revalidation_tests`, `tests/http/role-expiry.test.ts`, `use-users-queries.test.ts`, `user-form-dialog.test.tsx`; dialog and watcher checked against a running gateway.

## 2026-11-12 22:50 [decision]

B6 keeps to the expiry: upstream's soft revocation (`revoked_at`), assignment history and expiry presets are not ported. An expired row is kept and shown as expired rather than deleted, so `POST` on it still answers `409` and `PUT` extends it. Only expiries the administrator edited are sent on save: the `datetime-local` input has minute precision and would otherwise rewrite, or fail on, untouched values.

## 2026-11-12 23:20 [progress]

RDP/VNC step 3: `TargetOptions::Rdp` / `::Vnc` with `TargetKind::Rdp` / `Vnc` (RDP verifies the upstream certificate by default; keystroke recording is off by default on both), account kind `desktop-password` (username optional so one kind serves VNC), `roles.allow_clipboard` (migration `m00025`, default off), reachability probe arms, inline-secret keep/redact/clear handling. Web: both kinds in the target form (domain, certificate verification, keystroke switch), the account form and the role form; no connect action yet. Sessions cannot be opened until the bridge lands (steps 4 to 6).

## 2026-11-12 23:20 [BUG-P2]

First-install `POST /api/admin/setup/init` could fail with `database is locked` when a startup task wrote at the same moment: the transaction reads before it writes, and SQLite refuses that lock upgrade at once instead of waiting for the busy timeout. Admin creation now retries up to five times. Seen in about one of eight single-file integration runs; no deterministic reproduction, so there is no regression test.

## 2026-11-12 23:50 [progress]

RDP/VNC step 4: crate `gated-protocol-vnc` (client only, `vnc-rs` 0.6). `connect(VncClientOptions)` runs the target connection on its own task and returns `DesktopClientHandles`; connect and handshake run under the shared desktop deadlines, events and inputs travel over bounded channels, update requests are paced at 25 per second, clipboard text is dropped in both directions unless `allow_clipboard` is set and is capped at 1 MiB, and errors reach the viewer as a fixed reason. `vnc-rs` enforces the desktop size (8192 per edge, 8,294,400 pixels), compressed-length and string limits itself and implements VNC authentication only, so there are no DH parameters to check. `deny.toml` gains the `Unlicense` exception for `async_io_stream`. Tests use an in-process RFB 3.8 server.

## 2026-11-12 23:50 [decision]

RDP/VNC step order: the bridge (step 6) and the web client (step 7) are built on VNC first, then `gated-protocol-rdp` (step 5) is added behind the same handles. The plan already notes VNC is usable end to end without RDP, and this gets the shared path under a real browser test before the larger client lands.

## 2026-11-12 23:55 [progress]

RDP/VNC step 6 (bridge), on VNC: `GET /api/desktop/{target}` upgrades to a WebSocket (`gated-admin/src/http_service/api/desktop`). Same gate as the web terminal: login session, API token or ticket (target-scoped, rechecked every 10 s), `Origin` guard, role grant; sessions register as `WebVNC` / `WebRDP`, so the monitor lists them, an administrator can close them and authorization changes end them. Limits: 4 sessions per user, 32 in total, 4 MiB per viewer message, clipboard text cut to 1 MiB. The backend writes into a gateway-side framebuffer and marks 64 px tiles; the sender takes the marked area when the socket is ready (JPEG quality 90 without chroma subsampling, raw RGBA under 4 KiB), so a slow viewer gets fewer and larger updates and nothing queues. Control messages are JSON text, pixels are binary frames. Clipboard needs `allow_clipboard` on a role that grants the target (`ConfigProvider::authorize_clipboard`), is filtered in the bridge and in the protocol client, and a role that loses the switch loses it in running sessions within 10 s. Recording uses `start_desktop`; keystrokes and pasted text are recorded only with the target's `record_keystrokes`. Credentials: `account_credentials::desktop_login` (selected `desktop-password` account, else the inline ones). RDP targets answer "cannot be opened yet" until step 5. Tests: unit tests in the bridge and `tests/desktop/vnc.test.ts` against an `x11vnc` container (`tests/images/vnc-server`).

## 2026-11-12 23:55 [decision]

Desktop bridge choices that differ from upstream: one viewer per session (no shared sessions, no keyframe hand-off); lossy tiles are not refined with PNG later, the JPEG settings are chosen for readable text instead; no empty-session cleanup, because the recorder is still flushing when the socket closes; pasted clipboard text is treated like keystrokes for recording.

## 2026-11-12 23:55 [pitfall]

`vnc-rs` reports a rejected password on RFB 3.8 as `VncError::General(<server text>)`, not `WrongPassword`. The client records whether the target asked for the password and classifies a later handshake failure as rejected credentials. Also: its `poll_event` is non-blocking, so a `select!` over it spins; the client uses `recv_event` and paces update requests with a timer.

## 2026-11-12 23:55 [pitfall]

Integration suites that need upstream containers do run in the `station` sandbox with `E2E_DOCKER_PUBLISHED_HOST=172.18.0.1` (the `traefik` gateway). `tests/ssh/mfa-enforcement.test.ts`, written earlier without a run, passes.

## 2026-11-12 22:21 [progress]

RDP/VNC step 7 (web client and playback), on VNC: the desktop page at `/ui/desktop/<target>` (canvas, pointer, wheel, keys as keysym plus set-1 scancode, held keys released on blur, Ctrl+Alt+Del, clipboard only when the session shares it, reconnect after close), reached from the asset list, the target page and ticket handoff. Recording playback: `GET /admin/api/recordings/{id}/desktop` streams the stored recording (one JSON item per line), and the recording page plays it on a canvas with play/pause, seek, 1x to 8x speed, a marker at the recorded pointer and the recorded keys and pastes; seeking draws from the last keyframe. The session page offers the recording as a `.jsonl` download. Checked in a headless browser against the `x11vnc` container.

## 2026-11-12 22:21 [BUG-P1]

The content security policy added in the security work (not released) had `script-src 'self'`, which stops the terminal recording player: its emulator is WebAssembly, and compiling it needs `'wasm-unsafe-eval'`. The browser reported `CompileError ... violates Content Security Policy` on every recording page. The policy now carries `'wasm-unsafe-eval'`, which permits WebAssembly compilation only, not evaluating script text. Found by the browser check of desktop playback; the unit test asserts the directive.

## 2026-11-12 22:21 [pitfall]

The playback component first restarted from time zero on every render: its seek callback depended on `t` from `useTranslation`, and an effect keyed on that callback reran. Callbacks that drive playback now depend on the recording only and translation happens at render. Also: the player holds the whole recording in memory (base64 images), so a long session costs several times its file size in the browser tab.

## 2026-11-12 22:21 [pitfall]

The timestamps of the changelog entries dated 2026-11-12 from 13:20 on were estimates and run ahead of the clock (by up to about two hours). Entries from here on use the system time, so this one is earlier than its predecessors; the file order is the real order.

## 2026-11-12 22:48 [progress]

RDP/VNC step 5: crate `gated-protocol-rdp` (client only, stock IronRDP 0.12/0.13 from crates.io, nothing vendored). TLS always, CredSSP/NTLM when the target offers it, no plain RDP security, no Kerberos (the client refuses authentication steps that need a network request). Automatic logon with the account's user name, domain and password; bitmap and RemoteFX graphics; scancode input with a US-layout and Unicode fallback for viewers that send characters only; dynamic resize over the display control channel with a keyframe that keeps the old screen across the reactivation; text clipboard, with the channel not opened at all unless the role allows it. The bridge passes the viewer's window size (`width`/`height` query), so the desktop opens at that size. `deny.toml` ignores RUSTSEC-2026-0441 (`pin-utils`, macOS-only path), as decided. Tests: 23 unit tests, `tests/desktop/rdp.test.ts` against an `xrdp` container (`tests/images/rdp-server`), browser check.

## 2026-11-12 22:48 [decision]

RDP choices: the graphics pipeline channel (EGFX) is not enabled, the same default as upstream, which drops `ironrdp-egfx` from the tree; a target without NLA is accepted over TLS (xrdp needs it), with the certificate check as the protection; the clipboard limit is 1 MiB like VNC and the bridge.

## 2026-11-12 22:48 [decision]

Tile JPEGs are encoded with the `image` crate instead of `jpeg-encoder`. `jpeg-encoder` is licensed `(MIT OR Apache-2.0) AND IJG` and IJG is not in the allow list of `deny.toml`; the check after step 6 was not rerun, so this went unnoticed until now. `image` (MIT OR Apache-2.0, no default features, `jpeg` only) passes without an exception and also encodes without chroma subsampling. It has no SIMD path, so encoding is slower; allowing IJG for `jpeg-encoder` would be the faster option and is the owner's call.

## 2026-11-12 22:48 [BUG-P1]

`generate_keys` in `gated-protocol-ssh` held a write transaction while it generated the RSA host key, which takes seconds. A listener storing its first TLS certificate at the same moment ran into the 5 s busy timeout, and that error ends the process: `Fatal error: protocol server: PostgreSQL ... database is locked`, seen once right after first-run setup in an integration run. The keys are now generated before the transaction opens. No deterministic reproduction, so no regression test.

## 2026-11-12 22:48 [pitfall]

In the RDP session loop a channel receiver whose sender had been dropped (the clipboard channel when the clipboard is off) returned `None` at once, which the loop takes as the end of the session: the connection closed right after connecting, without an error. The sender is now kept for the whole session. In a `select!` over several receivers, a closed one fires immediately every time.

## 2026-11-12 22:57 [progress]

RDP/VNC step 8 (hardening and documentation), which closes the plan. The upstream certificate endpoint and the Security tab of a target now cover RDP: `gated-protocol-rdp::inspect_certificate` sends the X.224 connection request and reads the chain over the upgraded stream (`gated-tls::inspect_peer_chain_over`); the tab shows RDP as TLS required with `verify_tls`, and VNC as unencrypted. The RDP client rejects a desktop size reported by the target that is empty, wider or taller than 8192 pixels, or above 64 MiB of RGBA, at connect and at every reactivation. The target form says under a VNC target that the connection to the target is not encrypted. New: `docs/architecture/protocol-desktop.md` (and zh-CN), desktop sections in `docs/api.md`. Verified: clippy clean, 447 Rust tests, cargo-deny ok, web lint/typecheck/i18n/build and 595 tests, `tests/desktop/rdp.test.ts` (3), `tests/desktop/vnc.test.ts` (8), `tests/api/targets/desktop.test.ts` (4). Not verified: NLA and dynamic resize, which need a Windows target (xrdp supports neither).
