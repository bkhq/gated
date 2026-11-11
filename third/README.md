# Third-party sources

## sqlx 0.8.6 (`sqlx/`)

The crates `sqlx`, `sqlx-core`, `sqlx-macros`, `sqlx-macros-core`,
`sqlx-mysql`, `sqlx-postgres` and `sqlx-sqlite` from
<https://github.com/launchbadge/sqlx> at tag `v0.8.6`
(`bab1b022bd56a64f9a08b46b36b97c5cff19d77e`), MIT OR Apache-2.0; tests,
examples, benches and the CLI are left out.

One change: `sqlx-sqlite/Cargo.toml` requires `libsqlite3-sys = "0.40.0"`
instead of `^0.30.1`. `libsqlite3-sys` 0.40 bundles SQLCipher 4.20.0 on
SQLite 3.54.1, which fixes RUSTSEC-2026-0459 (CVE-2026-119375); every sqlx
release up to 0.9.0 caps `libsqlite3-sys` below that, and the gateway needs
the bundled SQLCipher for its encrypted database and static musl builds.

The root `Cargo.toml` applies it through `[patch.crates-io]`. Remove this
directory and the patch once a sqlx release allows `libsqlite3-sys` 0.40
and sea-orm depends on it.
