# 20261111-1425-short-web-session-erases-audit Stop short web terminal sessions from deleting their audit trail

- **status**: pending
- **priority**: P1
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

`cleanup_empty_session` (`http_service/api/db_terminal.rs:629`) deletes the session row and its recordings when a web SSH or DB terminal lasted under two seconds, or a DB terminal produced no output. A scripted client can open the terminal, run a command and close within that window, leaving no session and no recording.

Acceptance:
- A session that reached the target and exchanged any input or output keeps its row and recordings regardless of duration.
- Only sessions that never connected are discarded.
- A test runs a command in a sub-two-second web SSH session and finds the session and recording afterwards.

## ActiveForm

Preserving audit data for short web sessions

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code; callers are the end of `api_ssh_terminal` in `ssh_terminal.rs` and `handle_db_terminal`. Also fix here: a recording that fails to start lets the terminal continue unrecorded without telling anyone, and web sessions store no `remote_address`.
