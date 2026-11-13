# 20261112-1301-rdp-vnc-web-desktop Add RDP and VNC targets with a browser desktop client

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-12 13:01

## Description

Upstream Warpgate gained RDP and VNC targets after the fork point. Bring the feature to Gated: RDP and VNC target kinds, a browser desktop client, desktop session recording and replay, with the access, audit and resource controls the other target kinds already have.

Acceptance: see plan `20261112-1301-rdp-vnc-web-desktop`.

## ActiveForm

Adding RDP and VNC desktop targets

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Plan: `docs/plan/20261112-1301-rdp-vnc-web-desktop.md`. Upstream reference: `warpgate-protocol-rdp`, `warpgate-protocol-vnc`, `warpgate-web-desktop`, `warpgate-core/src/protocols/{desktop,framebuffer}.rs`, `warpgate-core/src/recordings/desktop.rs` at `5aca27f8`.

2026-11-12: step 1 done (dependency check, `docs/decisions/20261112-rdp-vnc-dependencies.md`). Step 2: `protocols/desktop.rs` and `protocols/framebuffer.rs` ported with tests; desktop recorder pending. Steps 3 to 8 not started.

2026-11-12: step 2 done (desktop recorder with seek index, `RecordingKind::Desktop`). Next: step 3 (target kinds, `allow_clipboard` migration, OpenAPI snapshots).

2026-11-12: step 3 done (target kinds, `desktop-password` accounts, `roles.allow_clipboard`, OpenAPI, web forms; `tests/api/targets/desktop.test.ts`). Next: step 4 (`gated-protocol-vnc`).

2026-11-12: step 4 done (`gated-protocol-vnc`, 10 tests). Order changed: step 6 (bridge) and step 7 (web client) next, on VNC; step 5 (RDP) after them.

2026-11-12: step 6 done for VNC (bridge endpoint, limits, clipboard gate, recording; `tests/desktop/vnc.test.ts` 8 pass). Next: step 7 (web client, recording player), then step 5 (RDP), then step 8.

2026-11-12: step 7 done on VNC (desktop page, connect actions, recording playback with `GET /admin/api/recordings/{id}/desktop`; browser-checked). Fixed on the way: the new CSP blocked WebAssembly, which the terminal recording player needs. Next: step 5 (RDP), then step 8.

2026-11-12: step 5 done (`gated-protocol-rdp` on stock IronRDP, hooked into the bridge; `tests/desktop/rdp.test.ts` 2 pass against xrdp; browser-checked). Step 8 done (`docs/architecture/protocol-desktop.md` + zh-CN, `docs/api.md`, README). Not verified: NLA and dynamic resize, which need a Windows target.

- complete: All 8 plan steps done; NLA and dynamic resize unverified (no Windows target)
