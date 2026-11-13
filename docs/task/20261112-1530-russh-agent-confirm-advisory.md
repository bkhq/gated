# 20261112-1530-russh-agent-confirm-advisory Upgrade russh for RUSTSEC-2026-0495

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-12 15:30

## Description

`cargo deny check advisories` fails on `main`: RUSTSEC-2026-0495, "Agent server signs with confirm-constrained keys without calling `Agent::confirm`", in `russh` 0.63.3. The fix is in `russh` 0.65.0.

Acceptance:
- Decide whether Gated uses the affected agent-server code path.
- Upgrade `russh` to a fixed release (two minor versions, API changes expected) or record an ignore with the reason.
- `cargo deny check` passes.

## ActiveForm

Upgrading russh

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Found while running `cargo deny check` for plan 20261112-1301-rdp-vnc-web-desktop; not caused by that work.

- complete: russh 0.65.1; cargo deny check passes (advisories, bans, licenses, sources); 345 workspace tests pass, clippy and fmt clean. Gated does not use the russh agent server. SSH integration suite not run in station.
