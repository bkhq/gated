# 20261112-1300-idle-session-sign-out Sign the web UI out when its session expired while idle

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-12 13:00

## Description

An idle page kept showing the signed-in UI after its session had expired on the gateway, until the next request. The UI should notice and return to the login page.

Acceptance:
- A page left open returns to the login page within about a minute of its session expiring, and when the tab becomes visible again.
- The check does not extend the session.

## ActiveForm

Signing out idle pages

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Requested by the owner on 2026-11-12. Done: `GET /api/auth/session` (not counted as activity) polled by `useSessionWatch`. The expiry itself was verified against the gateway with a 20 s lifetime; the browser side was not exercised in a real browser.
