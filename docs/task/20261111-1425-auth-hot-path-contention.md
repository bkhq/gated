# 20261111-1425-auth-hot-path-contention Take password hashing and full-table scans out of the global auth lock

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

Every protocol authenticates through one `Mutex<ConfigProviderEnum>`. `validate_credential` (`gated-core/src/config_providers/db.rs:258`) verifies Argon2 hashes on the async runtime while holding it, so unauthenticated password attempts serialize and delay authorization for the whole gateway, HTTP proxy requests included. `AuthStateStore::create` loads every user per attempt, and target resolution loads every target per request.

Acceptance:
- Password verification runs off the async workers and outside the provider lock.
- User and target lookups query by name.
- A benchmark or test shows authorization latency stays flat under concurrent failing logins.

## ActiveForm

Removing contention from the authentication path

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code; no load measurement was taken.
