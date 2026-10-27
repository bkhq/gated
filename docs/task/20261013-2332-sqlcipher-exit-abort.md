# 20261013-2332-sqlcipher-exit-abort Investigate abort at process exit after SQLCipher use

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-10-13 23:32

## Description

Under cargo-nextest (one process per test), `gated-admin` test `http_service::api::encryption::tests::init_migrates_existing_plaintext_sqlite_database` passed and then the process aborted with `double free or corruption (fasttop)` (SIGABRT). Seen once in seven runs; not reproduced under `cargo test`. The likely cause is a race at process exit between database worker threads and C library teardown in the bundled SQLCipher/OpenSSL. Determine the cause and whether the gateway can abort the same way on shutdown. Acceptance: root cause documented and fixed, or shown to be test-only; the nextest `ci` profile retry can then be reconsidered.

## ActiveForm

Investigating exit-time abort

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Found while adopting cargo-nextest. The `ci` nextest profile retries failed tests twice, which hides this in CI.
