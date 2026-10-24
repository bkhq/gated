# 20261024-0120-auth-failures-pagination Keep failed authentications out of sessions and paginate unbounded lists

- **status**: completed
- **priority**: P2
- **owner**: worker/gated-auth-pagination-1024
- **createdAt**: 2026-10-24 01:20

## Description

Every SSH/MySQL/PostgreSQL connection inserts a session row at accept time, so failed logins and port scans show up as zero-length sessions. Failed authentications belong in the audit log instead. Separately, several list pages load a fixed batch (sessions 500, audit 200, tickets all) without paging. Plan: `docs/plan/20261024-0120-auth-failures-pagination.md`.

## ActiveForm

Deferring session rows to authentication and adding pagination to unbounded lists

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- complete: session rows written on authentication, `auth_login_rejected` audit for SSH (once per connection) and MySQL/PostgreSQL, `GET /sessions` filters and paging, audit Load more, ticket paging. Web 401 tests, Rust unit tests (incl. gated-core session row tests), new `tests/ssh/failed-auth-audit` and `tests/ssh/session-filters`, all of tests/ssh, tests/api/sessions and tests/db PostgreSQL pass. Locally the MySQL native-client cases fail identically on the previous binary: the available MariaDB 10.6 client trips a handshake parse error; CI uses the noble client.
