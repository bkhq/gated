# 20261021-0228-web-sftp-file-manager Add an audited SFTP file manager to the web UI

- **status**: completed
- **priority**: P2
- **owner**: worker/gated-sftp-1021
- **createdAt**: 2026-10-21 02:28

## Description

Let users browse and transfer files on SSH targets from the web UI, through the gateway, with every file operation audited. Acceptance:

- A user with access to an SSH target can list directories, download, upload, create directories, rename and delete files from the web UI.
- Each operation is written to a `file_audit` recording on the session (operation, path, size, result) and shows up in the session's recordings.
- Access follows the existing target role assignments; the host key must already be trusted (or the mode is `auto_accept`).
- Rust, frontend and integration suites pass; a new integration test covers list/upload/download/delete against the SSH test image.

Also in scope (approved 2026-10-21): a per-role file transfer permission enforced for web and native SFTP, and `file_audit` recordings for native SFTP. Out of scope: read-only target mode, resumable transfers.

## ActiveForm

Adding the web SFTP file manager

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Plan: `docs/plan/20261021-0228-web-sftp-file-manager.md`.

- complete: Web file manager, role file transfer switch, native and web SFTP audit; Rust, web and tests/ssh/sftp.test.ts pass
