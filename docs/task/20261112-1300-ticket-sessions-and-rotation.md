# 20261112-1300-ticket-sessions-and-rotation Tell ticket sessions apart, list them per ticket and rotate ticket secrets

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-12 13:00

## Description

Sessions opened with a ticket looked the same as sessions of a user who signed in: the `sessions.ticket_id` column was never written. A ticket had no list of its sessions and its secret could not be replaced.

Acceptance:
- Proxy and browser sessions opened with a ticket carry its id and are marked in the session lists; the lists filter by sign-in kind.
- A ticket links to the sessions opened with it.
- A ticket's secret can be rotated by its owner or an administrator; the old secret stops working and its sessions end.

## ActiveForm

Linking tickets to sessions and adding rotation

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Requested by the owner on 2026-11-12. Done; plan `20261112-1300-ticket-sessions-and-rotation`. Deleting a ticket still clears `ticket_id` on its past sessions (foreign key `SET NULL`).
