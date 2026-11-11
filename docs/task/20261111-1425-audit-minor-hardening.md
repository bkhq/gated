# 20261111-1425-audit-minor-hardening Fix the small hardening items from the November audit

- **status**: pending
- **priority**: P3
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

Low-severity items, each a few lines:
- `gated-core/src/config_providers/mod.rs:110` logs an unknown ticket secret in plain text.
- The MySQL and Postgres proxies log every SQL statement at info level (`gated-protocol-mysql/src/session.rs:515`, `gated-protocol-postgres/src/session.rs:902`), while the SSH path deliberately logs only the length; statements may carry secrets.
- `middleware/db_lock.rs` answers 423 while the architecture document says 503.
- The SSO return handler hard-codes `https://{host}` and does not URL-encode `login_error`.
- `api_change_password` checks the old password without a rate limit.
- In `Prompt` host-key mode any end user can accept and persist an unknown SSH host key for everyone (`gated-protocol-ssh/src/client/handler.rs`); consider making `AutoReject` plus admin trust the default.
- MySQL result relay has a `todo check multiple results`; multi-result responses may desynchronize the relay.

Acceptance: each item fixed or explicitly declined in Notes, with a test where behaviour changes.

## ActiveForm

Applying minor audit hardening

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). All confirmed by reading the code; the MySQL multi-result case is unverified.
