# 20261111-1425-session-revocation-on-identity-change Revoke sessions when a user's credentials or identity change

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

Admin-side password or credential changes, role removal, user deletion and user rename leave that user's management sessions alive. Sessions and tickets refer to users and targets by name, so a rename, or a delete followed by a re-create under the same name, re-binds old sessions and tickets to the new object. Deleting a target leaves its tickets behind. The session id is not rotated at login.

Acceptance:
- Changing or removing a credential, deleting a user and removing admin rights end that user's management sessions (the acting session may stay on a self-service change).
- Sessions and tickets are bound to user and target ids; deleting either removes dependent tickets.
- A new session id is issued at login.
- Tests cover password change, user delete and a delete-and-recreate under the same name.

## ActiveForm

Revoking sessions on identity changes

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code. Changing tickets to ids needs a migration: Full tier with a plan.
