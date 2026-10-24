# 20261020-2140-improve-web-ssh-terminal Improve the web SSH terminal host key flow and input ergonomics

- **status**: completed
- **priority**: P2
- **owner**: worker/gated-terminal-1020
- **createdAt**: 2026-10-20 21:40

## Description

Improve the browser SSH terminal, using the EdgeSSH review as reference. Acceptance:

- The host key prompt shows the target host and port and the OpenSSH `SHA256:` fingerprint; the raw public key stays available but secondary.
- A changed host key (known-host mismatch) and a policy rejection (`auto_reject`) each produce a specific error message instead of the generic "SSH connection failed" / "unknown host key rejected".
- A key bar under the terminal sends Esc, Tab, Ctrl+C/D/Z/L and arrow keys through the existing data frame.
- Frontend unit tests, Rust tests, lint, typecheck and i18n check pass.

Out of scope (separate tasks if wanted): resource status bar / process list, command snippets, SFTP file manager.

## ActiveForm

Improving the web SSH terminal

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Plan: `docs/plan/20261020-2140-improve-web-ssh-terminal.md`.

- complete: Rust, web unit tests, lint, typecheck, i18n check and clippy pass; host key prompt and mismatch verified end to end against a live target.
