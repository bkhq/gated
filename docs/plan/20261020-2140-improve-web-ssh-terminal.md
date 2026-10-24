# 20261020-2140-improve-web-ssh-terminal Improve the web SSH terminal host key flow and input ergonomics

- **status**: completed
- **createdAt**: 2026-10-20 21:40
- **approvedAt**: 2026-10-20 23:02
- **relatedTask**: 20261020-2140-improve-web-ssh-terminal

## Context

Web SSH terminal: `GET /api/ssh/terminal/{target}` in `crates/gated-admin/src/http_service/api/ssh_terminal.rs`, frontend in `web/src/features/terminal/`. Frames: `0x00` data, `0x01` resize, `0x02` status, `0x03` host key verify (`docs/api.md` §1.8).

- Host key prompt (`handle_host_key_verification`, `ssh.host_key_verification = prompt`) sends `{ status, algorithm, key_base64 }`. `HostKeyVerifyDialog` shows the algorithm and the full base64 public key. No `SHA256:` fingerprint, no host/port, so the user cannot compare it with `ssh-keygen -lf` output.
- Known-host mismatch: `client/handler.rs` returns `ConnectionError::HostKeyMismatch` with both keys; `wait_for_connection` maps every `RCEvent::ConnectionError` to the status message "SSH connection failed". A changed host key is indistinguishable from a network error.
- `auto_reject` (the default) sends "Host key verification failed: unknown host key rejected" with no hint that the key must be added under Known hosts.
- The terminal page has no on-screen keys; mobile and some browsers cannot send Esc, Ctrl combinations or arrows reliably.
- Existing tests: `codec.test.ts`, `host-key-verify-dialog.test.tsx`, `use-terminal-socket.test.ts`, `terminal-status-banner.test.tsx`; Rust unit tests in `ssh_terminal.rs`.

Reviewed and deferred: a resource status bar and process list would make the gateway run hidden exec commands on the target outside the user's shell, bypassing session recording and command ACLs; snippets need a table, migration and API. Both need their own decision.

## Proposal

1. Backend (`ssh_terminal.rs`): add `fingerprint` (`key.fingerprint(HashAlg::Sha256)`, `SHA256:…`), `host` and `port` to the `0x03` frame; existing fields unchanged. Pass host/port from the resolved `ssh_options`.
2. Backend: in `wait_for_connection`, match `ConnectionError::HostKeyMismatch` and send `error` "Host key mismatch: the target presented SHA256:<received>, expected SHA256:<known>. Verify the host and update Known hosts." Change the `auto_reject` message to say the key is unknown and must be added under Known hosts by an administrator.
3. Frontend codec: parse the optional `fingerprint`, `host`, `port` fields (optional, so an older server still decodes).
4. `HostKeyVerifyDialog`: show target `host:port`, algorithm and the fingerprint prominently; the base64 key in a collapsed `<details>`. Keep the countdown.
5. New `TerminalKeyBar` component under the terminal for SSH: Esc, Tab, Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, ←↑↓→. Each button calls `socket.sendInput` with the control bytes and refocuses xterm.
6. i18n keys in `en` and `zh-CN`; update `docs/api.md` §1.8.
7. Tests first: codec decoding of the new fields, dialog rendering of fingerprint/host, key bar byte sequences, Rust unit test for fingerprint frame and mismatch message.

## Risks

- Protocol change is additive; old frontends ignore the new fields. The status message texts change; tests matching the old strings need updating.
- Key bar bytes go through the normal data path, so recording and command ACL behave the same as typed input.
- `HashAlg` import comes from russh's re-exported `ssh-key`; no new dependency.

## Scope

About 8 files: `ssh_terminal.rs`, `codec.ts`, `host-key-verify-dialog.tsx`, `terminal-screen.tsx`, new `terminal-key-bar.tsx`, two locale files, `docs/api.md`, plus tests.

## Alternatives

- Compute the fingerprint in the browser with `crypto.subtle` from `key_base64`: no backend change, but `crypto.subtle` needs a secure context and host/port would still be missing.
- Also implement the resource status bar now: rejected for this task for the audit reason above.

## Annotations

(none)
