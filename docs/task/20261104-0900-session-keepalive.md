# 20261104-0900-session-keepalive Let users pick a sliding admin session lifetime

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-04 09:00

## Description

Admin UI sessions end on a fixed schedule. Users should choose how long a session stays signed in (for example 30 minutes or 4 hours), and activity should push the expiry forward. Acceptance: the user picks a lifetime from a fixed list; every authenticated request extends the session by that lifetime; the session ends only after that long without activity or on sign-out/revocation; tests cover the sliding expiry and the choice.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- Two expiries apply today (`crates/gated-admin/src/http_service/session.rs`, wired in `http_service/mod.rs`):
  - Idle: `SessionStore::vacuum(admin.session_max_age)` drops a management handle after 30 minutes (default) without a request; `track_session` touches it on every request. This one already slides, but its length is a server-wide `config.yaml` value.
  - Absolute: `SessionLayer` stores the cookie session with `expires_at = now + admin.cookie_max_age` (24 h) only when session data changes (sign-in), and sets the cookie `Max-Age` once at creation. Activity does not extend either, so a user is signed out 24 h after sign-in however active they are.
- No lifetime choice exists in the login page or profile.
- Five queries poll with `refetchInterval`; those requests count as activity today.

Proposed plan:
1. Lifetime choice: a select on the login page ("Stay signed in": 30 min, 1 h, 4 h, 8 h, 24 h), remembered in the browser; default = `admin.session_max_age`. The chosen lifetime is stored in the session at sign-in. The user can change it for the current session in the profile page.
2. Sliding expiry: each authenticated request moves the idle deadline, the cookie-session `expires_at` and the cookie `Max-Age` (re-sent at most once a minute) to now + lifetime. The fixed 24 h cap is removed; `cookie_max_age` stays as the upper bound of the selectable lifetimes.
3. API: login accepts an optional `session_lifetime` (seconds, must be one of the offered values); `GET /info` (or the profile endpoint) reports the current lifetime and options; `PUT` endpoint to change it for the current session. Admin sessions page shows each session's expiry.
4. Tests: Rust tests for sliding expiry and lifetime validation; web tests for the selector; docs, changelog.

Open question: background polling (`refetchInterval`) keeps a session alive while a page is left open. Recommendation: keep counting it (simple, matches today's idle behaviour).

Decisions during implementation (approved: options 30 min / 1 h / 4 h / 8 h / 24 h, polling counts as activity):
- One endpoint, `PUT /api/auth/session-lifetime`, serves both the login page (called before password or SSO sign-in; the value is kept in the pre-login session and carries over) and the profile page; the login request itself is unchanged.
- The idle lifetime is stored as a session entry and synced to `SessionStore` on every request (`touch`); the cookie session layer slides by `cookie_max_age` on every load.
- Revised after review: polling must not extend a session. Only navigation and mutations count, reported through `POST /api/auth/activity` at most once a minute; every other request leaves the idle timestamp alone.
