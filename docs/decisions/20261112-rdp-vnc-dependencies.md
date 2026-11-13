# RDP and VNC client dependencies

- **date**: 2026-11-12
- **status**: decided 2026-11-12
- **plan**: 20261112-1301-rdp-vnc-web-desktop (step 1)

## What was checked

A scratch crate with the client-side crates the plan needs, resolved at the latest stable versions on crates.io, built on the pinned toolchain (1.95.0) and checked with the repository's `deny.toml`:

`ironrdp-connector` 0.12, `ironrdp-session` 0.13, `ironrdp-tokio` 0.12, `ironrdp-pdu` 0.11, `ironrdp-graphics` 0.11, `ironrdp-input` 0.9, `ironrdp-cliprdr` 0.9, `ironrdp-displaycontrol` 0.10, `ironrdp-dvc` 0.10, `ironrdp-egfx` 0.5, `ironrdp-core` 0.3, `vnc-rs` 0.6.0.

## Result

- Builds on stable 1.95; no nightly feature is needed.
- `cargo deny check bans`: ok. The tree contains no `openssl`, `openssl-sys`, `native-tls`, `ring` or `reqwest`. `sspi` 0.23 (NLA, pulled by `ironrdp-connector`) uses its `aws-lc-rs` provider by default.
- `cargo deny check sources`: ok.
- No vendored IronRDP crate is needed for the browser-only scope: `ironrdp-server` is not in the tree.
- The tree adds about 330 crates to resolve, most of them already in `Cargo.lock`.

Two findings need a policy exception. Both were accepted by the owner on 2026-11-12 and are added to `deny.toml` in the change that brings the crates into the workspace:

| Finding | Cause | Decision |
|---|---|---|
| License `Unlicense` is not in the allow list | `async_io_stream` 0.3.3, pulled by `vnc-rs` | Allowed for this crate only (`[[licenses.exceptions]]`). It is a public-domain dedication. |
| RUSTSEC-2026-0441: `pin-utils` is unmaintained | `sspi` -> `async-dnssd` -> `pin-utils`; not a vulnerability | Added to `advisories.ignore`. |

Replacing the `pin-utils` path with our own code was considered and rejected:

- `async-dnssd` is a dependency of `sspi` on macOS and iOS only (`cfg(any(target_os = "macos", target_os = "ios"))`). It is flagged because `deny.toml` checks the Apple targets too; it is never compiled into the Linux binaries Gated ships.
- Avoiding `sspi` means writing CredSSP and NTLM ourselves, and `ironrdp-connector` depends on `sspi` unconditionally, so the connector would have to be forked as well.
- Patching `pin-utils` or `async-dnssd` with a local copy would only move the unmaintained code into this repository.

Other points to know, no action proposed:

- `ironrdp-connector` pins `picky` to the pre-release `=7.0.0-rc.26`, and the tree carries `rsa` 0.10.0-rc.18. Both come from IronRDP's own manifests.
- `sspi` enables its smart-card feature (`winscard`, `cryptoki`) through `ironrdp-connector`; it cannot be switched off from outside. `winscard` pulls `flate2` with `libz-sys`, a C zlib built from source.

## Already added

`png` 0.18 and `zune-jpeg` 0.5 in `gated-core`, for the framebuffer (`protocols/framebuffer.rs`). Both are pure Rust and pass `cargo deny check` without exceptions.
