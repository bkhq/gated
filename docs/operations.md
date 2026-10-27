# Operating Gated

English | [简体中文](operations.zh-CN.md)

## Build and install

Use the toolchain pinned in `rust-toolchain.toml`, Bun, a C/C++ compiler,
OpenSSL development headers (for the bundled encrypted SQLite build), and
`pkg-config`. Portable musl builds additionally need the configured musl
compiler. The GNU path used in CI and local development is:

```bash
cd web
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run test
cd ..
CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu cargo test --workspace --all-features --locked
CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu cargo build --release --all-features --locked
```

Install `target/x86_64-unknown-linux-gnu/release/gated` under a dedicated
unprivileged service account. Build the frontend **before** the final Rust
binary: the UI is embedded at compile time. Preserve the previous executable
and its matching configuration for rollback. Do not deploy a source checkout
as if it were an immutable release artifact.

## First start and configuration

Choose a private data directory writable only by the service account and pass
it as `--data-dir` (or `GATED_DATA_DIR`). gated then reads `<dir>/config.yaml`
and keeps the database, host keys, TLS keys, recordings and encryption state
in the same directory, with paths in the config stored relative to it, so the
directory can be backed up and restored or moved as a unit. Use
`gated --data-dir /var/lib/gated unattended-setup --admin-port 8888
--ssh-port 2222 --external-host access.example.net --record-sessions` on one
line. Supply the initial password through the
`GATED_ADMIN_PASSWORD` environment variable from the deployment secret store;
do not put it in shell history or command-line arguments. Unset it after setup.
Do not rerun setup over an existing installation.

The setup command generates configuration and keys. Inspect that configuration
before starting `gated --data-dir /var/lib/gated run`. Without `--data-dir`,
`--config` (default `/etc/gated.yaml`) selects the config file and relative
paths resolve next to it. The container image sets `GATED_DATA_DIR=/data`.
Keep the config, database, host keys, TLS keys,
and recording directory private. Bind management access only to the operator
network or a trusted TLS reverse proxy. Disable protocols you do not use.

For a plaintext HTTP proxy behind a trusted TLS terminator, set
`http.behind_proxy: true` explicitly and restrict network reachability to that
terminator. For local development, a plaintext `http.listen: 127.0.0.1:8443`
needs no bypass. Do not disable the non-loopback plaintext-listener guard.
Configure `external_host` / `admin.external_port` and `admin.cookie_domain` for the
actual management origin; test cookies and SSO callbacks at that origin.

The root `config.yaml` is local, ignored configuration, not a portable deployment
example. `just dev` uses GNU builds and nsl to give the UI and API one origin.
Run `bun run build` before a standalone typecheck on a fresh checkout so the
TanStack route tree exists.

## Credentials, trust, and encryption

- Add target roles and bind users to the required roles. API tokens retain the
  user's permissions; tickets additionally restrict access to one target.
- SSH defaults to `auto_reject`. Enroll verified upstream host keys in the
  Known Hosts administration page before connecting. Confirm fingerprints by
  a separate trusted channel. `prompt` is an explicit interactive TOFU choice;
  `auto_accept` is suitable only for disposable test environments.
- Verify upstream TLS certificates. Configure appropriate CA trust instead of
  disabling verification. Database targets must support the required TLS mode;
  credential downgrade is rejected.
- Password changes require the current password. Enable self-service credential
  management in gateway parameters if users should manage their credentials.
  OTP enrollment issues a server-side setup key, then requires a valid live code
  before enabling the device. Keep another tested administrator recovery path.
- With `encryption.enable: true`, initialize/unlock through the management boot
  screen. The bootstrap token is generated in the data directory's
  `db/bootstrap-token.txt`; use the actual path reported by the service. Securely
  retain the master password outside the gateway. Restarting a locked deployment
  requires its configured unlock procedure. Back up `meta.db` together with the
  encrypted database; neither alone is a recoverable backup.
- Initializing encryption over an existing plaintext SQLite database keeps the
  original as `db.sqlite3.plain.bak` (owner-only when file securing is on) next to the
  encrypted database. It holds every stored secret unencrypted. The boot screen
  and the `encryption_plaintext_backup_retained` audit log report its path;
  after verifying the encrypted gateway, delete it together with any
  `-wal`/`-shm` sidecars. `gated encrypt-existing-db --auto-delete-plaintext`
  deletes it automatically on the CLI path.

## Backup and restore

Use a maintenance window for a consistent backup:

1. Stop the service and wait for its process to exit so SQLite and recordings
   finish writing. Verify shutdown with your service manager.
2. Copy the **entire** data directory, configured recording directory (if outside
   it), configuration and executable into a protected backup. Include database
   sidecars if any remain, encryption metadata, and SSH/TLS private keys. Retain
   permissions and ownership. Do not copy just the main SQLite file while the
   process is running.
3. Store a checksum manifest and the exact executable/version with the backup.
   Protect backups as credentials: recordings and database metadata are sensitive.
4. Restart and validate authentication and a real target connection.

Restore into an isolated directory with the matching executable and config,
restore ownership, then unlock and verify a known recording and target. Only
switch the service to the restored directory after this rehearsal succeeds.
Never overwrite the live directory as the first restore step. For externally
hosted databases, take a consistent database-native backup in the same window.

## Upgrade and rollback

Make a tested backup, stop the old process, stage the new binary, and restart
with the existing configuration.
Database migrations run on startup. Test login, OTP, target authorization,
SSH host-key verification, database queries, and recording playback. Roll back
by restoring the **matching database/config/binary set**; a binary downgrade
alone is not a safe migration rollback. Do not initialize over existing state.

### Running under lode

[`deploy/lode/lode.toml`](../deploy/lode/lode.toml) is a demo configuration for
the [lode](https://lode.bk.io) supervisor. It follows the signed `gated-linux-*.tar.gz`
archives on the bkhq/gated GitHub Releases and passes an absolute
`--data-dir` in `[command]` so all state stays outside lode's version
directories. `gated run`
exits cleanly on SIGTERM and, with `readiness = "state"`, reports ready to lode
once its listeners are up (or, with encryption enabled, once the pre-unlock UI
serves). Keep `policy = "check"` and apply updates after a backup: migrations
run on startup, so lode's automatic rollback to an older binary is not a safe
migration rollback.

[`deploy/lode/Dockerfile`](../deploy/lode/Dockerfile) builds a container image
for this setup on the `bkhq/lode` slim image. It adds the clients the web
MySQL and PostgreSQL terminals start (`mycli` with the MariaDB `mysql` as a
fallback, and `psql`); without them those terminals fail to start. lode
downloads the gated release itself, so the image does not change with gated
versions. Mount a volume at `/srv/gated-lode` and `lode.toml` into it.

## Monitoring and audit

Check the configured health endpoint and scrape metrics only on a private
listener. Confirm the management UI loads from the installed binary, perform a
real target connection, and verify that its recording can be replayed. Listener
readiness alone does not prove end-to-end proxying.

Management mutations persist actor, path, method, correlation ID, and requested /
completed phases in the dedicated `management_audit` table. Request bodies,
query strings, confirmation credentials and response payloads are excluded.
A requested record without completion needs investigation. Browser logins use
an independent in-memory management registry and create no proxy-session
rows, metrics or recording handles. Failed logins create no session rows either;
each one writes an `auth_login_rejected` entry to the connection audit log. Password changes revoke other browser and
proxy sessions; proxy-session termination does not log the operator out.

The audit UI selects either target connections (`POST /admin/api/logs`) or
management actions (`POST /admin/api/management-audit`). Only explicitly tagged
`audit` tracing events persist; request, query and channel diagnostics remain
observability output. Connection records are emitted after successful native
SSH/MySQL/PostgreSQL/HTTP upstream connections, once per target per session.
Web terminals retain their `WebSSH`, `WebMySQL` and `WebPostgreSQL` origins.

Set `log.management_retention` independently of `log.retention`. Both default
to the existing retention default. They share the encrypted database and backup
boundary, but management rows have no proxy-session foreign key and are not
removed by session deletion. Historical records remain in `log` and retain
original protocol names; the new store begins at deployment cutover. A down
migration copies management records back into `log` before removing the table.
SQL group identifiers remain bound to the user and target.

Credential reveal requires an identified admin plus a current password or OTP
and a nonempty reason (maximum 500 characters). The shared administrative token
cannot identify an operator and cannot reveal credentials. Limits are five
attempts per account and ten per operator per minute. OTP reveal is restricted
to once per operator in a 120-second window; successful OTP audit records also
prevent reuse after a restart. The UI clears confirmation immediately after
submission and revealed values on close/hide or after 60 seconds; responses
are marked `no-store`.

Enable recordings explicitly and set disk retention/capacity controls in your
deployment. Send audit copies to independently administered storage when you
need protection against a database administrator altering local logs. This
release does not claim a tamper-proof audit store.

## Release verification

`just clippy`, frontend checks and workspace tests must pass locally. Run
`just openapi` after API edits and `bun run openapi --check` from `web/` to detect
stale committed contracts. Run the integration tests on a host where their
upstreams are reachable. A local pass does not establish that the forge ran CI
or that a release artifact was published; confirm those separately before a
production rollout.
