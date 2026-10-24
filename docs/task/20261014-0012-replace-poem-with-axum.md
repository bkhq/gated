# 20261014-0012-replace-poem-with-axum Replace poem with axum and utoipa

- **status**: completed
- **priority**: P1
- **owner**: worker/9zjkmujd
- **createdAt**: 2026-10-14 00:12

## Description

Remove `poem` and `poem-openapi` (and the `vendor/` copies) from the workspace and serve the HTTP surface with axum, generating the OpenAPI documents with utoipa. Requested through decision event jnk3t54s: the vendored crates pull in the unmaintained `serde_yaml` (RUSTSEC-2024-0449) and already need a local patch for `quick-xml`. Acceptance: no `poem*` crate in `Cargo.lock`, `vendor/` and the `[patch.crates-io]` section removed, `cargo deny check` passes without new ignores, the admin and user OpenAPI documents are compatible with the committed snapshots (`oasdiff`), and the Rust, frontend and integration suites pass.

## ActiveForm

Replacing poem with axum

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Plan: [20261014-0012-replace-poem-with-axum](../plan/20261014-0012-replace-poem-with-axum.md)
