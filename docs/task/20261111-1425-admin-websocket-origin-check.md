# 20261111-1425-admin-websocket-origin-check Check the Origin on admin WebSockets and stop trusting every subdomain

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

User terminal WebSockets call `is_ws_origin_allowed`; the admin ones do not: `/admin/api/recordings/{id}/stream`, `/admin/api/sessions/changes`, `/admin/api/sessions/{id}/monitor`. Separately, `is_ws_origin_allowed` (`middleware/cookie_host.rs:20`) accepts any subdomain of the external host and the session cookie is set for `.host`. When HTTP proxy targets are served under `<label>.<base_domain>` beneath that host, a page from any proxied application can open terminal WebSockets with the visitor's session.

Acceptance:
- Every cookie-authenticated WebSocket route rejects a foreign Origin; the check is applied in one place.
- A subdomain is trusted only when configured, and proxied target hosts never are.
- Tests extend `tests/http/ws-origin.test.ts` to the admin routes and to a sibling-subdomain Origin.

## ActiveForm

Tightening WebSocket origin checks

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code; the subdomain case depends on deployment and was not reproduced.
