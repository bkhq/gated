# 20261111-2200-command-control-coverage Apply command control on every access path

- **status**: completed
- **createdAt**: 2026-11-11 22:00
- **approvedAt**: 2026-11-11 22:00 (owner instruction to handle all remaining audit tasks)
- **relatedTask**: 20261111-1425-command-control-coverage

## Context

Command ACL was evaluated only in the native proxies: SSH `exec` and PTY input (`gated-protocol-ssh/src/server/session.rs`), MySQL `COM_QUERY` and PostgreSQL `Query`/`Execute`. The web SSH terminal (`ssh_terminal.rs`), the SQL console (`db_query.rs`) and a native shell without a PTY (`_data` checked `pty_channels` only) skipped it, so a command denied on one path ran on another.

## Proposal

1. Native SSH: track every shell channel (`shell_channels`) and run `filter_pty_input` for it whether or not a PTY was requested.
2. Web SSH terminal: a `CommandFilter` built on `DbCommandAclEnforcer` rebuilds lines from terminal input, records each as a `shell-commands` item with `origin: web`, and on `deny` or `review` withholds the line, tells the browser and closes the terminal.
3. SQL console: evaluate `DbCommandAclEnforcer` with the target's protocol before running the statement; `deny` and `review` answer `403` and are written to the console's SQL audit recording.
4. `docs/design/command-control.md` gains a coverage table and states what stays best effort and what the file transfer permission covers.

## Risks

- Interactive enforcement stays reconstruction-based; the document says so.
- A `review` rule ends a web terminal instead of waiting; the native PTY path already blocks the same way.
- The web path evaluates rules through `DbCommandAclEnforcer` while the native SSH path uses its own loader; both call `command_acl::evaluate`, but the enforcement point is not yet one shared function.

## Scope

`crates/gated-protocol-ssh/src/server/session.rs`, `crates/gated-admin/src/http_service/api/{ssh_terminal,db_query}.rs`, `docs/design/command-control(.zh-CN).md`, tests in `tests/ssh/acl-filter.test.ts`, `tests/ssh/web-terminal-revocation.test.ts`, `tests/db/sql-console.test.ts`.

## Alternatives

Refusing the web terminal and non-PTY shells whenever a rule applies: simpler, but removes the web terminal for every user of a target with any rule.

## Verification

- `tests/db/sql-console.test.ts` "a command-ACL deny rule blocks a matching console query": passed locally.
- The two SSH tests need the `gated-e2e-ssh-server` port published to the test process and `sshpass`; neither is available in the development container, so they have not been run.
