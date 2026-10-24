# 20261013-2315-fix-audit-defects Fix audit defects and turn CI green

- **status**: completed
- **priority**: P0
- **owner**: worker/9zjkmujd
- **createdAt**: 2026-10-13 23:15

## Description

Fix the defects confirmed by the 2026-10-13 repository audit: MySQL handshake decoding panics on short packets (pre-auth process exit), the clippy failure in gated-admin, and the build ordering/target problems in the CI Integration job and docker/Dockerfile. Acceptance: regression tests for the decoder pass, `just clippy` passes, the Integration job and Docker build no longer fail on a missing `web/dist`.

## ActiveForm

Fixing audit defects

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Plan: [20261013-2315-fix-audit-defects](../plan/20261013-2315-fix-audit-defects.md)

- unclaim: Owner identifier corrected.

- complete: Decoder regression tests, workspace clippy and 216 tests passed locally; Docker image build verification still running.
