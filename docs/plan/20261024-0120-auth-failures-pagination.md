# Plan: failed authentications in the audit log, pagination for unbounded lists

## 1. Session rows only after authentication

Current: `State::register_session` (`gated-core/src/state.rs`) inserts the `sessions` row on accept; `GatedServerHandle::set_user_info` later fills `username`. Every protocol calls `set_user_info` only on success (SSH `_auth_accept`, MySQL/PostgreSQL session, HTTP, web terminal, SFTP), and recordings (the only FK to `sessions`) start after it.

Change:
- `register_session` keeps the in-memory state, metrics and change broadcast but no longer inserts.
- `set_user_info` inserts the row (id, started = registration time, remote address, protocol, username, plus a target snapshot if `set_target` ran first, as HTTP does). `set_target` before authentication only updates memory.
- `remove_session` marks the row ended only if it exists; an unauthenticated session leaves nothing in `sessions`.
- Live views read only authenticated sessions, so an in-progress login does not appear either.

Audit:
- Emit `warn!(target: "audit", session, protocol, remote_address, username, method, "Authentication failed")` at the rejection points: SSH password/public key/keyboard-interactive and target-not-authorized, MySQL and PostgreSQL `fail`. Entries go to the `log` table as today and appear on the audit page.
- A connection that closes without ever attempting authentication (scanner) is not logged per connection, to avoid flooding the audit log.
- Audit rows whose session has no `sessions` row are not linked to a session detail page.
- Keep `logged_in_only` in the web session lists so rows written before this change (no user) stay hidden.

Tests: Rust unit test in gated-core (unauthenticated session leaves no row; authenticated one has started/ended/username); integration test in `tests/ssh` (wrong password: no session row, audit entry present; correct password: session listed).

## 2. Pagination

Surveyed every list page:

| Page | Today | Change |
|---|---|---|
| Session monitor, past tab | one request `limit=500`, filters client-side; older sessions silently missing | server-side `offset/limit` with total, 50 per page, Prev/Next like command records; protocol/search/time filters move to query params on `GET /sessions` |
| Session monitor, live tab | same request | separate `active_only=true` request, no paging (bounded by concurrent sessions) |
| Target detail / user drawer session tabs | slice of the same 500 | request with `target` / `username` filter, 50 per page |
| Audit log (session and management planes) | `limit=200`, no way to see older | Load more using the existing `before` cursor |
| Tickets (admin and user) | backend returns all | client-side paging (20 per page) like the users page; tickets are bounded but accumulate expired/used entries |
| Command records, file records | server paging | no change |
| Users | client paging (10) | no change |
| Targets, roles, known hosts, command ACL, API tokens, public keys, accounts | full list | no change: configuration-sized lists |
| Command reviews | pending cards only | no change |
| Overview recent activity | `limit=100` widget | no change |

Backend: `GET /sessions` gains `protocol`, `search` (id/username/target), `since`, `target`, `username` params; OpenAPI types regenerated; `docs/api.md` updated.

## Verify

- `cargo clippy`/`test` for gated-core, gated-admin, protocol crates; web lint/typecheck/i18n/vitest; integration tests `tests/ssh`, `tests/api/sessions*`, audit tests; browser check on a throwaway instance: failed ssh login leaves no session and shows in the audit log; past sessions page through >50 rows; audit Load more.
