# 20261013-2315-harden-runtime-edition-2024 Harden runtime and migrate to edition 2024

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-10-13 23:15

## Description

Graceful shutdown of protocol servers with log flush and deterministic SIGINT handling, streaming download of traffic recordings, core-dump suppression and a structured panic hook, then migrate the workspace to edition 2024 / resolver 3. Acceptance: tests and gates pass on edition 2024; shutdown and recording download are covered by tests.

## ActiveForm

Hardening runtime

## Dependencies

- **blocked by**: 20261013-2315-adopt-quality-gates
- **blocks**: (none)

## Notes

Plan: [20261013-2315-harden-runtime-edition-2024](../plan/20261013-2315-harden-runtime-edition-2024.md)
