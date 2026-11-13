# 20261112-1254-known-host-key-type-switch Reject an SSH host key of a different type than the trusted one

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-12 12:54

## Description

`KnownHosts::validate` (`gated-protocol-ssh/src/known_hosts.rs`) looks up trusted keys by host, port and key type. A target that presents a key of another type than the trusted one is reported as unknown instead of mismatched, so the connection falls into the trust-on-first-use path instead of failing.

Acceptance:
- A host with a trusted key that presents a key of a different type fails validation as a mismatch.
- A host with no trusted key is still reported as unknown; a matching key is still valid.
- A unit test covers the three cases.

## ActiveForm

Rejecting host keys of a different type

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: comparison with upstream Warpgate (`fe73525a`, 2026-11-02).

- complete: Unit test known_hosts::tests::key_of_another_type_is_a_mismatch failed before the change and passes after; workspace tests, clippy and fmt pass (glibc target, sibling Rust container).
