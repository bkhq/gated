# 20261104-2100-my-targets-only-granted Show admins only the targets their roles grant under My targets

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-04 21:00

## Description

For administrators, "My targets", the overview, quick connect, spotlight, the SQL console route and the user target detail listed every target in the catalogue, but the gateway authorizes connections by role (`authorize_target`: user roles ∩ target roles), so connecting to an ungranted target was refused. Acceptance: these user-facing views list exactly the targets `GET /api/targets` returns for the signed-in user, admins included; the admin pages keep the full catalogue.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- `useTargets()` returned the admin catalogue whenever the user was an admin. New `useMyTargets()` / `useMyTarget(id)` (`features/targets/hooks/use-targets-queries.ts`) start from `GET /api/targets`; for admins they keep the admin view (address, accounts, UUID ids) of those granted targets only.
- Switched: user targets page and detail, overview (also frequent targets), sessions quick connect, spotlight, SQL console route. Admin pages, tickets, command ACL, target groups and known hosts keep `useTargets()`.
- Backend unchanged: it already filtered `/api/targets` and refused ungranted connections.
