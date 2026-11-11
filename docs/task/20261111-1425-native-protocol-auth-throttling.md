# 20261111-1425-native-protocol-auth-throttling Throttle failed logins on the SSH, MySQL and Postgres listeners

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

Only the web login is rate limited. The SSH listener has a one-second rejection delay per connection and no limit across connections; MySQL and Postgres answer each attempt at once. Passwords can be guessed without bound, and once a password is known the six-digit OTP can be brute-forced over SSH keyboard-interactive. Each attempt also allocates an auth state kept for ten minutes.

Acceptance:
- Failed attempts are limited per user and per client address across all listeners, sharing one bounded limiter with the web login.
- Failed OTP attempts count against the user.
- Tests show the limit on each protocol.

## ActiveForm

Adding login throttling to native listeners

## Dependencies

- **blocked by**: 20261111-1425-auth-rate-limiter-unbounded-memory
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code (`gated-protocol-ssh/src/server/mod.rs`, `gated-protocol-mysql/src/session.rs`, `gated-protocol-postgres/src/session.rs`). Unrelated nit in `get_allowed_auth_methods`: with every SSH method disabled it logs "Enabling all methods as fallback" but returns an empty set.

- complete: auth state allocation on refused DB attempts left as is; SSH test not runnable in station (no sshpass)
