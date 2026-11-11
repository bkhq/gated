# Command Control (Command ACL) — Design Note

English | [简体中文](command-control.zh-CN.md)

This note documents the cross-proxy behavior of the command-ACL feature: how
each protocol proxy evaluates commands against the `command_acl_rule` table and,
in particular, how they behave on a rule **load** error versus an evaluated
**verdict**.

The matcher itself is DB-free (`gated-core/src/command_acl.rs`); the DB bridge is
`gated-core/src/command_acl_loader.rs` (`load_enabled_rules`,
`load_user_role_ids`, `DbCommandAclEnforcer`). The MySQL, Postgres, and SSH
proxies consume it.

## Default OFF

With no enabled rules the ruleset is empty and every command evaluates to
`Allow`.

## Fail-OPEN on rule-load error (all proxies)

When the ACL ruleset cannot be **loaded** (DB unavailable, query error), all
three proxies **fail-OPEN**: the command is forwarded rather than blocked.
This is not configurable.

Rationale: command control is a policy layer on top of a bastion whose primary
job is access. A transient policy-DB blip must not lock every user out of every
target (which is what fail-closed on a load error would do). The degraded state
is made observable instead of silent:

- a `WARN` log is emitted (`command control degraded (fail-open)`), and
- exactly one audit event is written per affected command:
  - MySQL / Postgres: a `SqlAuditRecordingItem::Query` with `success = true` and
    `error = "acl-load-error: command control degraded (fail-open)"`.
  - SSH: a `ShellCommandRecordingItem::Command` with `acl_action = "allow"` and
    `outcome = "acl-load-error: command control degraded (fail-open)"`.

## Evaluated verdicts stay fail-SAFE

The fail-open policy applies **only** to the load-error path. Once a ruleset is
loaded and a command is actually evaluated, `Deny` and `Review` still **block**:

- MySQL / Postgres: `Deny` and `Review` both block (the DB proxies have no
  interactive approval path; `Review` is recorded as
  `blocked-review-unsupported`).
- SSH `exec`: `Deny` blocks; `Review` pauses the session for admin
  approval/rejection with a bounded timeout that also blocks on timeout.
- SSH PTY (best-effort reconstruction): `Deny` and `Review` both block.

## Role-scoped rules on SSH

Role-scoped ACL rules match on SSH. The acting user's role UUIDs are resolved
once at authentication time (`load_user_role_ids`, the same loader the DB proxies
use) and stored on the session, then passed into `AclContext.role_ids` for both
`exec` and best-effort PTY evaluation. If role resolution fails the
set stays empty (best-effort) and global/protocol/target rules still apply.

## Coverage by access path

| Path | Enforced | Recorded | Notes |
|---|---|---|---|
| SSH `exec` | yes | yes (`origin: exec`) | Exact command line; `review` waits for an administrator. |
| SSH shell with a PTY | best effort | yes (`origin: pty`) | Lines are rebuilt from keystrokes at Enter. |
| SSH shell without a PTY (`ssh -T`, piped input) | best effort | yes (`origin: pty`) | Filtered like a PTY shell. |
| Web SSH terminal | best effort | yes (`origin: web`) | Same reconstruction; `deny` and `review` both end the terminal, since a browser terminal cannot wait for a review. |
| MySQL proxy (`COM_QUERY`) | yes | yes | Other commands that carry SQL are answered "Not implemented". |
| PostgreSQL proxy (simple and extended query) | yes | yes | Checked at `Query` and at `Execute`. |
| SQL console | yes | yes | `deny` and `review` both answer `403`. |

Best effort means reconstruction from the byte stream: line editing, history
recall, tab completion, pasted multi-line input, shell aliases and a nested
interpreter (`bash`, `python`, an editor's shell escape) all produce commands
the filter does not see as typed. Treat interactive rules as a guard-rail and
use `exec`-only access or the upstream account's privileges when a rule must
hold.

The per-role file transfer permission gates the `sftp` subsystem (native SFTP
and the web file manager). It does not stop `scp -O` (legacy protocol over
`exec`), `cat file | ssh target 'cat > file'`, or port forwarding; restrict
those with command rules on `exec` or on the upstream host.
