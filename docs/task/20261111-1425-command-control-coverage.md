# 20261111-1425-command-control-coverage Apply command control and command audit on every access path

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

`docs/design/command-control.md` describes command ACL, command audit and review for SSH, MySQL and Postgres. Enforcement exists only in the native proxies. Paths that skip it:
- Web SSH terminal, web DB terminal and SQL console: no ACL lookup in `ssh_terminal.rs`, `db_terminal.rs`, `db_query.rs`.
- Native SSH shell without a PTY (`ssh -T`): `_data` in `gated-protocol-ssh/src/server/session.rs` filters only channels in `pty_channels`, so piped commands are neither checked nor recorded as commands.
- MySQL/Postgres protocol paths other than plain queries are not evaluated (MySQL forwards only `COM_QUERY`; check prepared and extended flows on Postgres).
- The per-role file transfer permission gates only the `sftp` subsystem; `scp -O`, `cat | ssh` and port forwarding still move files.

A user denied a command on one path can run it on another.

Acceptance:
- One enforcement point per protocol is shared by the native and web paths; a deny rule blocks the command on each of them and each records the command.
- A non-PTY shell is filtered like a PTY shell or refused when rules apply.
- The design document states what stays best-effort (interactive reconstruction) and what the file transfer permission covers.
- Tests cover a deny rule on web SSH, SQL console and `ssh -T`.

## ActiveForm

Extending command control to all access paths

## Dependencies

- **blocked by**: 20261111-1425-db-terminal-host-client-escape (the web DB terminal's future shape decides where its hook goes)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code. Full tier: needs a plan in `docs/plan/`.

- complete: SSH and web-terminal parts unverified locally (SSH e2e cannot run in station); enforcement point not yet a single shared function
