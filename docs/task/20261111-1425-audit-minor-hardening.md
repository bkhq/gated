# 20261111-1425-audit-minor-hardening Fix the small hardening items from the November audit

- **status**: completed
- **priority**: P3
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

Low-severity items, each a few lines:
- `gated-core/src/config_providers/mod.rs:110` logs an unknown ticket secret in plain text.
- The MySQL and Postgres proxies log every SQL statement at info level (`gated-protocol-mysql/src/session.rs:515`, `gated-protocol-postgres/src/session.rs:902`), while the SSH path deliberately logs only the length; statements may carry secrets.
- `middleware/db_lock.rs` answers 423 while the architecture document says 503.
- The SSO return handler hard-codes `https://{host}` and does not URL-encode `login_error`.
- `api_change_password` checks the old password without a rate limit.
- In `Prompt` host-key mode any end user can accept and persist an unknown SSH host key for everyone (`gated-protocol-ssh/src/client/handler.rs`); consider making `AutoReject` plus admin trust the default.
- An explicit empty `ssh: []` credential policy should deny public-key login (`PublicKeyOrPolicy`); confirm current behaviour first.
- MySQL result relay has a `todo check multiple results`; multi-result responses may desynchronize the relay.

Acceptance: each item fixed or explicitly declined in Notes, with a test where behaviour changes.

## ActiveForm

Applying minor audit hardening

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). All confirmed by reading the code; the MySQL multi-result case is unverified.

Outcome (2026-11-11):
- Fixed: unknown ticket secret no longer logged; SQL statements logged by length at info (text at debug); `db_lock` documentation corrected to 423; `login_error` is percent-encoded; `api_change_password` uses the shared failed-login throttle (`tests/http/change-password-throttle.test.ts`).
- Declined, needs an owner decision: the SSO return URL keeps `https://{host}` (the right scheme depends on the deployment's TLS termination); `Prompt` host-key mode stays the default; an explicit empty `ssh: []` policy still lets a registered key sign in (confirmed in `PublicKeyOrPolicy`: an empty required list makes the key sufficient).
- Not done: the MySQL multi-result relay (`todo check multiple results`). The proxy does not advertise `CLIENT_MULTI_STATEMENTS`/`CLIENT_MULTI_RESULTS`; whether a stored procedure can still desynchronize the relay was not verified.


- complete: three items declined pending owner decision, MySQL multi-result relay not done; see Notes
