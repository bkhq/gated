# 20261112-1300-ticket-sessions-and-rotation Tell ticket sessions apart, list them per ticket and rotate ticket secrets

- **status**: completed
- **createdAt**: 2026-11-12 13:00
- **approvedAt**: 2026-11-12 13:00 (owner request)
- **relatedTask**: 20261112-1300-ticket-sessions-and-rotation

## Context

`sessions.ticket_id` existed in the schema and in `SessionSnapshot`, but nothing wrote it, so every session opened with a ticket was indistinguishable from a normal sign-in. Browser sessions opened with a ticket carried the id only in their cookie state. A leaked ticket secret could only be handled by deleting the ticket.

## Proposal

1. `GatedServerHandle::set_ticket` stores the ticket id in the session state; the row written by `set_user_info` includes it. Called by the SSH, MySQL and PostgreSQL ticket logins and by the web terminal and file manager when the request is a ticket session.
2. `ManagementSessionHandle.ticket_id` is set by `authorize_ticket_session` and returned by `GET /admin/api/management-sessions`.
3. `GET /admin/api/sessions` gains `ticket_id` and `via_ticket`.
4. `POST /admin/api/tickets/{id}/rotate` and `POST /api/profile/tickets/{id}/rotate` store a new secret hash, end the browser sessions of the ticket and close its open proxy sessions, and return the new secret once.
5. Web UI: a "temporary access" badge and a sign-in filter on the sessions page, a `?ticket=` scope reached from the ticket row ("View sessions"), and "Rotate" on both ticket pages, which shows the share dialog with the new secret.

## Risks

- Deleting a ticket clears `ticket_id` on its past sessions (`ON DELETE SET NULL`), so those sessions lose the mark. Keeping it needs a schema change and is not part of this work.
- Sessions that ended before this change have no ticket id.
- A file manager connection is shared per user, target and account; it is tagged with the ticket of the request that opened it.

## Scope

`crates/gated-core/src/{state.rs,protocols/handle.rs}`, the three protocol `session.rs` files, `crates/gated-admin/src/http_service/{common,session,session_handle}.rs`, `http_service/api/{tickets,ssh_terminal,sftp}.rs`, `api/{sessions_list,management_sessions,tickets_detail,tickets_list}.rs`, web `features/tickets`, `features/admin/monitor/admin-sessions-page.tsx`, both ticket pages, `docs/api(.zh-CN).md`.

## Alternatives

Rotating by creating a new ticket and deleting the old one: it would detach the session history from the ticket.

## Verification

- `tests/api/tickets/rotate.test.ts` (3 tests) passes: a ticket browser session names its ticket, rotation invalidates the old secret and ends its session, a user rotates only their own ticket.
- `tests/ssh/auth-ticket.test.ts` gained assertions for `ticket_id` and both filters; it needs the SSH test server and has not been run in the development container.
- Web: `admin-sessions-page.test.tsx` and `admin-tickets-page.test.tsx` cover the badge, the ticket scope and rotation.
