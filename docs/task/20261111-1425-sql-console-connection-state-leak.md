# 20261111-1425-sql-console-connection-state-leak Reset pooled SQL console connections between requests

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

The SQL console runs user SQL on a per-target sqlx pool shared by all users (`gated-core/src/db_pool_registry.rs`, `db_query.rs`). On a writable target nothing resets the connection afterwards: a `BEGIN` left open swallows the next user's writes until the connection is recycled, and `SET ROLE`, `SET search_path`, `USE`, session variables and temporary tables carry over to whoever gets the connection next.

Acceptance:
- State set by one request is not visible to the next (dedicated connection per request, or a reset such as `DISCARD ALL` / `COM_RESET_CONNECTION` plus rollback on release).
- Tests: an open transaction and a changed `search_path` do not affect a following request.

## ActiveForm

Isolating SQL console requests

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code.
