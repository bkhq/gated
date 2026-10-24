# 20261013-2315-adopt-quality-gates Adopt workspace lint policy and quality gates

- **status**: completed
- **createdAt**: 2026-10-13 23:15
- **approvedAt**: 2026-10-13 23:15
- **relatedTask**: 20261013-2315-adopt-quality-gates

## Context

Lint policy lives in `Cranky.toml` and is applied by `cargo cranky`; there is no `[workspace.lints]`, no `rust-version`, no `#![forbid(unsafe_code)]` (the workspace has no `unsafe`), and CI lacks fmt, nextest, doctest, typos and MSRV checks. `cargo fmt --all -- --check` reports 49 diffs on `9a50100`.

## Proposal

1. `[workspace.package]` with `rust-version`; `[workspace.lints]` carrying the current Cranky denies plus `warnings = deny` and `unsafe_code = forbid`; every member opts in with `[lints] workspace = true`; remove `Cranky.toml` and switch `just clippy` to `cargo clippy`.
2. `#![forbid(unsafe_code)]` at each crate root.
3. Format the workspace in a dedicated commit.
4. CI: fmt check, nextest + doctests, typos, MSRV check; pin the bun version.
5. Config cleanup: `deny.toml` bans for `openssl`/`native-tls` and `deny` for unknown sources, working path remapping, `.dockerignore` paths, `once_cell::sync::Lazy` to `std::sync::LazyLock`.

## Risks

- `warnings = deny` may surface existing warn-level diagnostics (for example `too_many_arguments`); each is fixed or allowed with a reason.
- Pedantic/nursery clippy groups are not enabled: on a 49k-line codebase they would produce a rewrite far beyond this task.

## Scope

Root and member `Cargo.toml` files, crate roots, `justfile`, `.github/workflows/`, `deny.toml`, `.cargo/config.toml`, `.dockerignore`, and a formatting-only commit.

## Alternatives

Keeping cargo-cranky works but keeps policy outside the manifest and depends on an unmaintained tool.

## Annotations

Approved by the user on 2026-10-13 ("1 2 3") after the audit proposal.
