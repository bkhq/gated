# 20261112-1301-rdp-vnc-web-desktop Add RDP and VNC targets with a browser desktop client

- **status**: completed
- **createdAt**: 2026-11-12 13:01
- **approvedAt**: 2026-11-12 14:30
- **relatedTask**: 20261112-1301-rdp-vnc-web-desktop

## Context

Gated forked from Warpgate around v0.21 (2026-03). Upstream added RDP and VNC in `ac66c5c8` (2026-07-06) and has changed them in about 40 commits since; the reference below is upstream `5aca27f8` (2026-11-11).

Upstream layout (Rust, about 10,000 lines, plus about 1,900 lines of Svelte):

| Upstream piece | Lines | Role |
|---|---|---|
| `warpgate-core/src/protocols/{desktop,framebuffer}.rs` | 880 | Protocol-neutral `DesktopEvent` / `DesktopInput` streams and a shared framebuffer |
| `warpgate-core/src/recordings/desktop.rs` | 690 | Desktop recording format |
| `warpgate-protocol-vnc` | 2,000 | VNC client towards the target (`vnc-rs` 0.6) and a native RFB listener |
| `warpgate-protocol-rdp` | 4,600 | RDP client towards the target (IronRDP) and a native RDP listener (`ironrdp-server`) |
| `warpgate-desktop-auth`, `warpgate-desktop-ui` | 1,060 | Login and OTP screens drawn into the framebuffer for the native listeners |
| `warpgate-web-desktop`, `warpgate-web-clients-common` | 1,900 | WebSocket bridge to the browser: dirty-rectangle tracking, JPEG tiles |
| Svelte client and recording player | 1,900 | Canvas renderer, input, clipboard, player |

Facts that shape the port:

- Upstream builds on a nightly toolchain (`#![feature(once_cell_try)]` in the RDP crate). Gated pins stable 1.95.
- Upstream vendors three patched IronRDP crates (about 20,000 lines): `ironrdp-server` is an unreleased git snapshot needed only by the native RDP listener; `ironrdp-connector` and `ironrdp-async` are patched only for the interactive-logon option (credential-less CredSSP). Gated removed `vendor/` and keeps one vendored crate (`third/sqlx`).
- IronRDP's NLA goes through `sspi`, which brings `picky`, `reqwest`, `winscard` and `libz-sys` (static C zlib). Upstream also has an optional OpenSSL backend for legacy TLS targets. Gated's `deny.toml` bans `openssl` and `native-tls`, and the workspace uses `aws-lc-rs`; upstream's RDP crate selects `ring`.
- Upstream's HTTP layer is poem; Gated's is axum, and the web client is React. The bridge and the client are rewritten, not copied. The protocol-neutral core types, the VNC client and the RDP client port with mechanical changes.
- Gated integration points: `TargetOptions` (`gated-common/src/config/target.rs`), `TargetKind` and `RecordingKind` (`gated-db-entities`), recordings (`gated-core/src/recordings`), target accounts for stored credentials, the web terminal endpoint as the model for a session-bound WebSocket (`gated-admin/src/http_service/api/ssh_terminal.rs`: role check, ticket binding and 10-second recheck, management session handle, Origin check, revocation on identity change), and the workspace tabs in `web/src/features/terminal`.

## Proposal

Browser-only access in this plan: the user opens an RDP or VNC target in a workspace tab, as with the web terminal. Native listeners (mstsc or a VNC viewer connecting to a gateway port) are left out; see Alternatives.

### Steps

1. **Dependency check.** Add the IronRDP client crates and `vnc-rs` at the latest stable versions from crates.io in a scratch branch, then run `cargo deny check` and `cargo tree`. Confirm no `openssl` / `native-tls`, that the TLS provider is `aws-lc-rs`, and that the licenses pass. Record the result in `docs/decisions/`. If `sspi` cannot be built without a banned crate, stop and report before any further work.
2. **Core.** `gated-core/src/protocols/desktop.rs` and `framebuffer.rs` (events, input, bounded channels), `RecordingKind::Desktop` and `recordings/desktop.rs`.
3. **Targets.** `TargetOptions::Rdp` / `::Vnc` and the matching `TargetKind` values. Credentials come from target accounts (password accounts), as for database targets. Target status probes cover the two new kinds. The kind column is a string and options are JSON, so the target kinds need no schema change; one migration adds `roles.allow_clipboard`.
4. **`gated-protocol-vnc`.** Client only: connect and handshake with timeouts, VNC password or no authentication, framebuffer updates, pointer and key input, clipboard text.
5. **`gated-protocol-rdp`.** Client only, on stock IronRDP: TLS + NLA (NTLM) autologon with the account's credentials, bitmap and RemoteFX/EGFX updates, input with keyboard layouts, dynamic resize, clipboard text. No interactive-logon option, no Kerberos, no legacy-TLS backend in this plan.
6. **Bridge.** `GET /api/desktop/{target}` WebSocket in `gated-admin`: authorizes like the web terminal, registers a session, starts the protocol client, sends dirty rectangles as JPEG tiles and receives input.
7. **Web.** `web/src/features/desktop`: canvas renderer, keyboard and pointer capture, resize, clipboard, connection states; a recording player for desktop recordings; RDP and VNC forms in the target editor; Connect on the target page. English and zh-CN strings.
8. **Docs and tests.** `docs/architecture/protocol-desktop.md` (+ zh-CN), `docs/api.md`, README feature list, changelog. Unit tests per crate; integration tests against an `xrdp` and a `tigervnc` container (connect, see a frame, type, record, replay, revoke).

### Security requirements

These are acceptance criteria, each with a test.

Access:
- The WebSocket applies the same checks as the web terminal: role grant on the target, ticket scope with periodic recheck, API-token rules, Origin check. A session opened through it is listed, can be terminated by an administrator, and ends when the user's credentials, roles or identity change.
- Native-protocol auth throttling does not apply (no listener); the endpoint is behind the existing login session.

Secrets:
- Target passwords stay on the gateway. They are never sent to the browser, never logged, and RDP reconnect cookies are kept out of log lines.
- Errors shown to the user are generic; the detail goes to the audit log.

Resource bounds (the protocol parsers face a target that may be hostile):
- Desktop size is capped (width, height and total pixels) for both protocols, on the initial size and on every resize.
- Connect, TLS and handshake have timeouts; VNC Tight and other length fields are bounds-checked before allocation; RFB DH parameters are range-checked.
- Event and input channels are bounded; a slow browser causes frames to be coalesced, not queued.
- A per-user and a global cap on concurrent desktop sessions, since each holds a framebuffer.

Audit:
- Every session is recorded when recordings are enabled; the session row carries the target, account and ticket like the other kinds.
- Keystrokes are not recorded by default, because they contain passwords typed into the remote desktop. A per-target option enables them.

Data paths:
- Clipboard is the only transfer channel. It is controlled per role by a new `allow_clipboard` switch (migration, default `false`); off means no clipboard in either direction. Drive, printer, audio and USB redirection are not implemented.

Target transport:
- RDP: TLS is required; certificate verification is a per-target option, as for database targets, and the Security tab shows the presented certificate.
- VNC: the RFB password scheme is DES-based and the stream is unencrypted. The target form says so; no gateway-side mitigation is possible.

Supply chain:
- No vendored IronRDP, no nightly features, `unsafe_code = forbid` in the new crates, `cargo deny check` passes.

## Risks

- `sspi` and its dependency tree may conflict with `deny.toml` or `aws-lc-rs`. Step 1 exists to find out before the rest is built.
- Stock IronRDP releases move together; a target that only works with upstream's patched crates (interactive logon) is out of scope and will not connect in that mode.
- The RDP client is the largest and least testable piece: `xrdp` in CI does not behave exactly like Windows. A Windows target is needed for a manual pass before release (NLA, RemoteFX, resize, clipboard).
- JPEG encoding of frames is CPU-bound on the gateway; concurrent desktop sessions cost more than terminal sessions. The session caps bound this but the right default needs measuring.
- Desktop recordings are large compared to terminal recordings; retention and disk usage change for installations that enable them.
- Binary size and build time grow (IronRDP, `sspi`, static zlib).

## Scope

New crates `gated-protocol-vnc`, `gated-protocol-rdp`; new modules in `gated-core` (`protocols/desktop.rs`, `protocols/framebuffer.rs`, `recordings/desktop.rs`); `gated-common` target options; `gated-db-entities` kinds; `gated-admin` bridge endpoint, target API and recording API; `web/src/features/desktop`, target forms, recording player, locales; OpenAPI snapshots; docs; integration tests and their containers.

Rough size: 6,000 to 7,000 lines of Rust and 2,500 to 3,500 lines of TypeScript, delivered in the step order above. VNC end to end (steps 1 to 4, 6, 7) is usable before RDP lands.

## Alternatives

- **Also port the native listeners** (mstsc / VNC viewer to a gateway port). Adds `ironrdp-server` (vendored git snapshot, 14,000 lines), the framebuffer login and OTP screens, two listeners with their own certificates and auth throttling, and about 4,000 more lines. Proposed as a follow-up plan once the browser path is stable.
- **Vendor upstream's patched IronRDP** to get interactive logon. Rejected for this plan: it reintroduces a `vendor/` tree the project removed.
- **Embed an existing web client (noVNC, Guacamole)** instead of a custom bridge. noVNC needs the browser to speak RFB to the target, which exposes the target password to the browser or needs a second RFB server on the gateway; Guacamole needs the `guacd` C daemon. Both break the single-binary model and the audit path.

## Annotations

Owner decisions (2026-11-12):

1. Browser access only; native listeners are not part of this plan.
2. Keystroke recording is off by default and enabled per target.
3. Clipboard has its own role switch, `allow_clipboard`, separate from `allow_file_transfer`.
