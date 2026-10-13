# Changelog

## 2026-10-13 23:21 [BUG-P0]

MySQL packet decoders panicked on truncated input (`Buf::get_*`, `advance`, `split_to`), which exits the process because the release profile aborts on panic. All decoders in `gated-database-protocols` now use checked reads and return a protocol error. Regression tests: `mysql/protocol/truncation_tests.rs`.

## 2026-10-13 23:21 [progress]

Repository audit of `9a50100` recorded as three tasks (`20261013-2315-*`). First task: decoder fix above, clippy `indexing_slicing` error in `gated-admin`, and `web/dist` ordering in the CI Integration job and `docker/Dockerfile` (which now also builds for an explicit glibc target on the pinned toolchain).

## 2026-10-13 23:40 [decision]

Lint policy moved from `Cranky.toml` to `[workspace.lints]` (`warnings = deny`, `unsafe_code = forbid`, the previous clippy denies) and every crate root carries `#![forbid(unsafe_code)]`. `rust-version` is 1.95, the same release as the pinned toolchain, so every CI job builds on the MSRV and no separate MSRV job is added. Clippy pedantic/nursery groups are not enabled.

## 2026-10-13 23:40 [progress]

CI gains formatting, typos, cargo-nextest (profile `ci`) and doctest gates, pins bun, and builds the release binary with `--locked`. `once_cell` is replaced by `std::sync::LazyLock`/`OnceLock`. `deny.toml` bans `openssl` and `native-tls` and denies unknown sources. Path remapping for release builds is now expanded by the shell; the `.cargo/config.toml` entries were literal `$HOME`/`$PWD` strings and had no effect.

## 2026-10-13 23:40 [pitfall]

`cargo deny check advisories` fails on RUSTSEC-2024-0449 (`unsafe-libyaml`, unmaintained, via `serde_yaml`); handling is pending a decision. One nextest run aborted at process exit after a passing SQLCipher test; tracked as `20261013-2332-sqlcipher-exit-abort`.
