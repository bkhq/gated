# 20261111-1425-db-readonly-enforcement Enforce the read-only target flag on every database path

- **status**: pending
- **priority**: P1
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

A database target's `readonly` flag is enforced only in the SQL console (`db_query.rs:928`, validator plus a READ ONLY transaction). The native MySQL and Postgres proxies record `readonly: None` and forward writes; the web DB terminal does not look at the flag. The UI promises "Reject DDL / DML / write operations" (`web/public/locales/en/common.json:821`, `target-form-drawer.tsx:442`).

Acceptance:
- A write through the native proxy or the web DB terminal to a read-only target is rejected, preferably by putting the upstream session in read-only mode rather than by parsing SQL alone.
- The validator treats MySQL `#` comments and backslash escapes the way the server does.
- Tests cover a write attempt on each path for both engines.

## ActiveForm

Enforcing read-only database targets everywhere

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code. A Postgres READ ONLY transaction still allows side effects through functions such as `dblink_exec` or `lo_import`; decide whether the function blocklist is the documented limit.
