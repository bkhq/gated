# 20261013-2315-adopt-quality-gates Adopt workspace lint policy and quality gates

- **status**: pending
- **priority**: P1
- **owner**: (unassigned)
- **createdAt**: 2026-10-13 23:15

## Description

Move lint policy into `[workspace.lints]` (replacing cargo-cranky), add `#![forbid(unsafe_code)]` to every crate root, declare `rust-version`, add fmt/nextest/doctest/typos/MSRV gates to CI, format the workspace, and clean up the low-severity config findings (deny.toml bans, path remapping, .dockerignore, unpinned bun, once_cell). Acceptance: all gates run in CI and pass.

## ActiveForm

Adopting quality gates

## Dependencies

- **blocked by**: 20261013-2315-fix-audit-defects
- **blocks**: (none)

## Notes

Plan: [20261013-2315-adopt-quality-gates](../plan/20261013-2315-adopt-quality-gates.md)
