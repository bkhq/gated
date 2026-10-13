# 20261013-2315-harden-runtime-edition-2024 Harden runtime and migrate to edition 2024

- **status**: implementing
- **createdAt**: 2026-10-13 23:15
- **approvedAt**: 2026-10-13 23:15
- **relatedTask**: 20261013-2315-harden-runtime-edition-2024

## Context

- `crates/gated/src/commands/run.rs` returns on SIGTERM without draining sessions, exits through `process::exit(1)` on a server error (skipping `LoggingGuards::shutdown`), and listens for SIGINT twice with different exit codes.
- `crates/gated-admin/src/api/recordings_detail.rs:194` reads a whole traffic recording with blocking `std::fs::read` inside an async handler.
- Core dumps are not suppressed in-process and the panic hook prints with `eprintln!`.
- All crates use edition 2021 with `resolver = "2"`.

## Proposal

1. Single shutdown path: one SIGINT/SIGTERM handler, errors propagated to `main` so logging is flushed, protocol servers given a bounded drain period.
2. Stream the recording file with `tokio::fs` instead of buffering it.
3. `setrlimit(CORE, 0)` at startup and a panic hook that logs through `tracing` before exiting.
4. Edition 2024 and `resolver = "3"` via `cargo fix --edition`, crate by crate, in a dedicated commit.

## Risks

- Edition 2024 changes temporary drop order in `if let` and tail expressions and RPIT lifetime capture; lock guards in async code need review after the mechanical fix.
- A drain period changes how fast the process stops under a supervisor; the bound must stay below typical stop timeouts.

## Scope

`crates/gated` (main, run), `gated-core` protocol server trait if a shutdown signal has to be threaded through, `gated-admin` recordings handler, every `Cargo.toml` for the edition bump.

## Alternatives

Deferring the edition migration keeps the diff small but leaves the workspace off the baseline; it is kept as the last, separable step.

## Annotations

Approved by the user on 2026-10-13 ("1 2 3") after the audit proposal.
