# 20261013-2332-sqlcipher-exit-abort Investigate abort at process exit after SQLCipher use

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-10-13 23:32

## Description

Under cargo-nextest (one process per test), `gated-admin` test `http_service::api::encryption::tests::init_migrates_existing_plaintext_sqlite_database` passed and then the process aborted with `double free or corruption (fasttop)` (SIGABRT). Seen once in seven runs; not reproduced under `cargo test`. The likely cause is a race at process exit between database worker threads and C library teardown in the bundled SQLCipher/OpenSSL. Determine the cause and whether the gateway can abort the same way on shutdown. Acceptance: root cause documented and fixed, or shown to be test-only; the nextest `ci` profile retry can then be reconsidered.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Found while adopting cargo-nextest. The `ci` nextest profile retries failed tests twice, which hides this in CI.

Root cause: dropping a sea-orm/sqlx SQLite connection only signals its worker thread, which closes the handle (and frees SQLCipher codec and OpenSSL state) afterwards. The test, the plaintext migration and the gateway's `run` shutdown all let the process exit with such threads still running, racing the C library's exit-time cleanup. Reproduced 4/200 by running the test in a loop, one process per run (as nextest does); 0/400 after the fix. Fix: after `Services::shutdown`, the `run` command waits for queued audit entries and closes the pool, the migration closes its connections before renaming files, and the tests close theirs. The nextest `ci` retries were removed. One-shot CLI commands only open plaintext databases and are unaffected.
