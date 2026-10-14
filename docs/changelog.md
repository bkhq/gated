# Changelog

## 2026-10-13 23:21 [BUG-P0]

MySQL packet decoders panicked on truncated input (`Buf::get_*`, `advance`, `split_to`), which exits the process because the release profile aborts on panic. All decoders in `gated-database-protocols` now use checked reads and return a protocol error. Regression tests: `mysql/protocol/truncation_tests.rs`.

## 2026-10-13 23:21 [progress]

Repository audit of `9a50100` recorded as three tasks (`20261013-2315-*`). First task: decoder fix above, clippy `indexing_slicing` error in `gated-admin`, and `web/dist` ordering in the CI Integration job and `docker/Dockerfile` (which now also builds for an explicit glibc target on the pinned toolchain).

## 2026-10-13 23:38 [decision]

Lint policy moved from `Cranky.toml` to `[workspace.lints]` (`warnings = deny`, `unsafe_code = forbid`, the previous clippy denies) and every crate root carries `#![forbid(unsafe_code)]`. `rust-version` is 1.95, the same release as the pinned toolchain, so every CI job builds on the MSRV and no separate MSRV job is added. Clippy pedantic/nursery groups are not enabled.

## 2026-10-13 23:38 [progress]

CI gains formatting, typos, cargo-nextest (profile `ci`) and doctest gates, pins bun, and builds the release binary with `--locked`. `once_cell` is replaced by `std::sync::LazyLock`/`OnceLock`. `deny.toml` bans `openssl` and `native-tls` and denies unknown sources. Path remapping for release builds is now expanded by the shell; the `.cargo/config.toml` entries were literal `$HOME`/`$PWD` strings and had no effect.

## 2026-10-13 23:38 [pitfall]

`cargo deny check advisories` fails on RUSTSEC-2024-0449 (`unsafe-libyaml`, unmaintained, via `serde_yaml`); handling is pending a decision. One nextest run aborted at process exit after a passing SQLCipher test; tracked as `20261013-2332-sqlcipher-exit-abort`.

## 2026-10-13 23:55 [progress]

Shutdown now closes live sessions and waits up to ten seconds for them to deregister and for recording writers to flush (`Services::shutdown`). Before this change a SIGTERM dropped up to five seconds of buffered recording data and left recordings without an end time. Traffic recording downloads are streamed. Core dumps are disabled at startup and panics are logged through tracing.

## 2026-10-13 23:55 [decision]

Workspace migrated to edition 2024 and resolver 3 with `cargo fix --edition`. `tail_expr_drop_order` flagged 130 sites where a tail-expression temporary is now dropped before locals; they were sampled (mostly awaited futures, lock guards and database handles released earlier), not reviewed one by one. `wrap_stream` gained a precise capture bound because the new `impl Trait` capture rules tied its result to the handle lock guard. `rand`'s `gen` is called as `r#gen` until the dependency is upgraded.

## 2026-10-14 00:00 [decision]

Decision event z0ytlcaj (option B): `gated` no longer depends on `serde_yaml`. The config file is parsed by the `config` crate into a `serde_json::Value` for the legacy-key migration, and setup writes the generated config with `serde-saphyr` 2.0 (pure Rust, serializer feature only). RUSTSEC-2024-0449 is still reported because the vendored `poem` and `poem-openapi` depend on `serde_yaml`.

## 2026-10-14 00:12 [decision]

Decision event jnk3t54s: the vendored poem crates will not be patched further; poem is to be replaced. Proposed as task and plan `20261014-0012-replace-poem-with-axum`, pending approval. Until that work lands, `cargo deny check advisories` keeps failing on RUSTSEC-2024-0449.

## 2026-10-14 01:05 [progress]

The management HTTP surface (`gated-admin`: admin and user APIs, sessions, middlewares, web terminals, the SPA) and the `gated` binary's probe and pre-unlock listeners now run on axum; the OpenAPI documents come from utoipa. The proxy listener in `gated-protocol-http` is still on poem. The regenerated snapshots are OpenAPI 3.1 and differ from the previous ones in representation only (nullable optionals, unsigned integer formats, inline unions); the JSON on the wire is unchanged. `tests/xml_compatibility.rs`, which only covered the vendored poem `Xml` payload, is removed.

## 2026-10-14 01:05 [pitfall]

`Router::nest("/ui", …)` in axum 0.8 does not match `/ui/`; the request falls through to the outer fallback, which for a signed-in browser redirected to `/ui/` again. The SPA router registers `/ui/` explicitly (`http_service::spa::routes`, with a test). utoipa documents an `IntoParams` query struct only when the operation lists it in `params(...)`.
