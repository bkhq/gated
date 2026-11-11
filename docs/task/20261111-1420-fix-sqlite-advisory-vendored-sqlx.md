# 20261111-1420-fix-sqlite-advisory-vendored-sqlx Fix RUSTSEC-2026-0459 with a vendored sqlx

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:20

## Description

CI's `cargo deny` fails on RUSTSEC-2026-0459 (CVE-2026-119375): the bundled SQLite before 3.54.0 can return uninitialised page-cache memory when a database is opened next to a crafted `-wal` file. Acceptance: the gateway builds against SQLCipher 4.20 / SQLite 3.54.1 (`libsqlite3-sys` 0.40), the encrypted database and the static musl build keep working, and `cargo deny` passes without an ignore entry.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: release v0.0.11

## Notes

Findings:
- The gateway uses `libsqlite3-sys` with `bundled-sqlcipher-vendored-openssl`. The advisory's fix is 0.39, but 0.39.x still bundles SQLCipher on SQLite 3.53.4; only 0.40.0 (2026-11-11, `sqlcipher-src` 420.0.0 = SQLCipher 4.20.0 / SQLite 3.54.1) fixes the SQLCipher build.
- Every sqlx release caps `libsqlite3-sys`: 0.8.6 at `^0.30.1`, 0.9.0 at `<0.38`; main (2026-11-09) at `<0.40`, unreleased. A `-sys` crate links `sqlite3`, so only one version can exist in the graph and sea-orm (119 files, 29 entities, 20 migrations) has no backend other than sqlx. Linking a system SQLite is out: the encrypted database and the musl binary need the bundled SQLCipher.
- Patching sqlx 0.8.6 to `libsqlite3-sys = "0.40.0"` type-checks, passes the gated-core and migration unit tests, builds the musl release and passes the encryption and ticket integration tests (verified in a scratch worktree).

Decision (user, 2026-11-11): fix it rather than ignore the advisory; keep the patched sqlx in the repository under `third/` instead of a fork.

Plan:
1. `third/sqlx`: the seven crates from sqlx v0.8.6 with the one-line bound change, tests/examples/CLI left out, README with origin and removal condition.
2. Root `Cargo.toml`: `libsqlite3-sys = "=0.40.0"` (the `min_sqlite_version_3_14_0` feature no longer exists), `[patch.crates-io]` to the vendored crates; `_typos.toml` excludes `third/`.
3. Gates: fmt, clippy, tests, `cargo deny`, typos; musl release build; full integration suite.

## Outcome

`third/sqlx` holds the seven sqlx 0.8.6 crates with `sqlx-sqlite` requiring `libsqlite3-sys = "0.40.0"`; the root `Cargo.toml` pins `libsqlite3-sys = "=0.40.0"` and patches the sqlx crates to the vendored copies. `Cargo.lock` resolves `sqlcipher-src 420.0.0` (SQLCipher 4.20.0 / SQLite 3.54.1). `deny.toml` allows `blessing` and `WTFPL`, which `sqlcipher-src` declares. Gates run locally in the Rust container: fmt, clippy, workspace tests, `cargo deny check` (advisories, bans, licenses, sources all ok), typos, musl release build; the full integration suite ran against the new binary. The sqlx sources print four dead-code and lifetime warnings of their own on local builds; they are not workspace members, so `warnings = deny` does not apply. Remove `third/sqlx` once a sqlx release allows `libsqlite3-sys` 0.40 and sea-orm depends on it.
