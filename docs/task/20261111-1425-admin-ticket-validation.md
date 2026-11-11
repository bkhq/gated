# 20261111-1425-admin-ticket-validation Validate admin-issued tickets and keep their sessions alive

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

`POST /admin/api/tickets` (`gated-admin/src/api/tickets_list.rs`) stores whatever user and target names it is given, with any expiry and use count; `docs/architecture/auth.md` says they are validated. `Services::revalidate_sessions` (`gated-core/src/services.rs:210`) closes every session whose user has no role on the target, so a session opened with a ticket for a target the user is not otherwise granted is closed on the next unrelated role or target change.

Acceptance:
- The endpoint rejects an unknown user or target, a past expiry and a non-positive use count.
- The intended rule is written down: either a ticket requires the user's own grant (then creation checks it) or it is a grant of its own (then revalidation skips ticket sessions while the ticket is valid).
- Tests cover both.

## ActiveForm

Validating admin-issued tickets

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code. Related: 20261111-1425-ticket-session-lifetime-and-revocation.
