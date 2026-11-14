# 20261114-0100-session-countdown-in-user-menu Show the time left on the browser session in the user menu

- **status**: completed
- **priority**: P3
- **owner**: lexuue
- **createdAt**: 2026-11-14 01:00

## Description

The user menu in the sidebar shows how long the browser session stays signed in without further activity, counting down.

- `GET /api/auth/session` answers 200 with the seconds left instead of 204. It still does not count as activity, so looking at the countdown does not extend the session.
- The menu asks once when it opens and counts down locally.

Acceptance:
- The endpoint reports the time left of the caller's session and 401 when signed out; asking does not extend the session.
- The open menu shows the time left and updates every second.
- English and zh-CN strings.

## ActiveForm

Showing the session countdown in the user menu

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes


- complete: Unit, component and integration tests pass; checked in a browser in en and zh-CN
