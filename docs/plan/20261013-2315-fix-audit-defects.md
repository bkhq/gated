# 20261013-2315-fix-audit-defects Fix audit defects and turn CI green

- **status**: implementing
- **createdAt**: 2026-10-13 23:15
- **approvedAt**: 2026-10-13 23:15
- **relatedTask**: 20261013-2315-fix-audit-defects

## Context

- `crates/gated-database-protocols/src/mysql/protocol/connect/handshake_response.rs` decodes the first client packet with `Buf::get_*`, `advance` and `split_to`, all of which panic on short input. `crates/gated-protocol-mysql/src/session.rs:139` passes the unauthenticated payload straight in. The release profile uses `panic = "abort"` and the panic hook in `crates/gated/src/main.rs` exits the process, so one short packet stops every listener. `mysql/io/buf.rs` (`get_uint_lenenc`, `get_bytes_lenenc`) and the other `Decode` impls share the pattern.
- `crates/gated-admin/src/api/accounts.rs:882` fails `clippy::indexing_slicing` (CI run 38477607721).
- The CI Integration job and `docker/Dockerfile` run `just openapi` before the frontend build; `gated-web` embeds `web/dist`, which does not exist yet. The Dockerfile also builds with the musl default target from `.cargo/config.toml` without `musl-gcc`, copies from `target/release`, and uses `rust:1.93.1` while `rust-toolchain.toml` pins 1.95.0.

## Proposal

1. Add failing tests for truncated handshake responses and length-encoded values, then make the decoders return `Error` instead of panicking: checked readers in `io/buf.rs` / `mysql/io/buf.rs`, used by every `Decode` impl in the crate.
2. Replace the JSON index assignment in `accounts.rs` with a map insert.
3. CI Integration job: create `web/dist` before `just openapi`. Dockerfile: same ordering fix, explicit `CARGO_BUILD_TARGET`, matching `COPY` path, `--locked`, base image aligned with the pinned toolchain.

## Risks

- Decoder signature changes touch every caller in `gated-protocol-mysql`; behaviour for valid packets must stay identical (existing tests cover the encoders and helpers).
- The Docker build cannot be exercised end to end without a tag push; it is verified by a local image build.

## Scope

`gated-database-protocols`, `gated-protocol-mysql` call sites, one line in `gated-admin`, `.github/workflows/ci.yml`, `docker/Dockerfile`.

## Alternatives

Wrapping each connection task in `catch_unwind` would contain the panic but is impossible under `panic = "abort"` and hides malformed-input bugs; rejected.

## Annotations

Approved by the user on 2026-10-13 ("1 2 3") after the audit proposal.
