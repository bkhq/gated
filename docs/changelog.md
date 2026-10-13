# Changelog

## 2026-10-13 23:55 [BUG-P0]

MySQL packet decoders panicked on truncated input (`Buf::get_*`, `advance`, `split_to`), which exits the process because the release profile aborts on panic. All decoders in `gated-database-protocols` now use checked reads and return a protocol error. Regression tests: `mysql/protocol/truncation_tests.rs`.

## 2026-10-13 23:55 [progress]

Repository audit of `9a50100` recorded as three tasks (`20261013-2315-*`). First task: decoder fix above, clippy `indexing_slicing` error in `gated-admin`, and `web/dist` ordering in the CI Integration job and `docker/Dockerfile` (which now also builds for an explicit glibc target on the pinned toolchain).
