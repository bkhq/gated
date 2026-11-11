# 20261111-1425-ticket-session-lifetime-and-revocation Bind a claimed ticket session to its ticket and make it revocable

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

Claiming a ticket (`http_service/api/tickets.rs:289`, `middleware/ticket.rs:59`) creates a cookie session that outlives the ticket: deleting or expiring the ticket does not end it, it has no management handle, so it is absent from `/admin/api/management-sessions` and cannot be revoked, and its only limit is a sliding 24 h cookie age.

Acceptance:
- Deleting a ticket or reaching its expiry ends its browser sessions and their open terminals.
- Ticket sessions appear in the management session list and can be revoked.
- The session has an absolute lifetime no longer than the ticket's.

## ActiveForm

Tying ticket sessions to their ticket

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Reproduced against the release binary: the session kept working after the ticket was deleted and was not listed.
