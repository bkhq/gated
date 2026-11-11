# 20261111-1425-auth-rate-limiter-unbounded-memory Bound the login rate limiter's memory

- **status**: pending
- **priority**: P1
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

The login limiter (`http_service/api/auth.rs:46-67,206`) keys its map by `username|ip`, inserts before any check, never prunes, and accepts a username of any length. Unauthenticated requests with unique long usernames grow the process without limit; the oversized username is also written to the log. OTP and ticket-claim share the limiter; the `setup.rs` and `encryption.rs` limiters are keyed by IP and are never pruned either. The unlock endpoint additionally runs a 256 MiB Argon2 derivation per attempt.

Acceptance:
- Username length is capped before the limiter and before logging.
- Limiter entries expire and the map has a hard size bound.
- Concurrent unlock derivations are bounded.
- A test shows memory stays flat under unique-username traffic.

## ActiveForm

Bounding the login rate limiter

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Reproduced: 60 requests with 1.5 MB usernames raised RSS from 35 MB to 124 MB. `middleware/cookie_host.rs` trusts `x-forwarded-*` unconditionally; check that the limiter's client IP honours `http.behind_proxy` the same way the proxy listener does.
