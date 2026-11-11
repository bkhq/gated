# 20261111-1425-db-terminal-host-client-escape Stop web DB terminals from giving users a shell on the gateway

- **status**: completed
- **priority**: P0
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

The web MySQL/Postgres terminal (`crates/gated-admin/src/http_service/api/db_terminal.rs`, `spawn_db_client`) runs `mycli` / `mysql` / `psql` on the gateway host with the target password in `MYSQL_PWD` / `PGPASSWORD` and bridges the raw PTY to the browser. These clients execute host commands and read/write host files on request (`\!`, `system`, `\copy ... program`, `\i`, `\o |cmd`, `source`, `tee`, pager and editor hooks). Any user or ticket holder with one DB target therefore gets command execution as the gateway user and can read the target password from the process environment, the gateway database and config. The clients ship in `deploy/lode/Dockerfile`.

Acceptance:
- A web DB terminal user cannot run a host command, read or write a gateway file, or learn the target credential, for all three clients.
- An integration test opens a DB terminal and shows that the shell-escape, file and pager paths fail.
- The decision between sandboxing the client and replacing it is recorded here before implementation.

## ActiveForm

Closing the host shell escape in web DB terminals

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code; not reproduced, because the test gateway host has no DB client installed.

Options to weigh in the proposal:
1. Drop the host client and serve the terminal from the existing SQL console backend (sqlx pool); no process, no secret in an environment.
2. Keep the client but run it confined: no shell escape (`psql` has no switch for it, so this needs a sandbox such as an empty mount namespace, seccomp or a dedicated unprivileged user with no filesystem access), credentials passed without the environment, pager and editor disabled.
3. Until fixed, gate the feature behind a config flag that defaults to off.

Option 2 is hard to make complete for `psql`; option 1 removes the class of bug. Related: 20261111-1425-command-control-coverage, 20261111-1425-db-readonly-enforcement.

- complete: Decision (owner, 2026-11-11): remove the host client. The terminal endpoints, PTY bridge and portable-pty are gone; database targets open in the SQL console (UI redirect, ticket claim, target header). Lode image no longer installs DB clients. Verified: clippy, gated-admin unit tests, web gates, tests/http/web-ticket-scope.
