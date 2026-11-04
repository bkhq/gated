# 20261104-1430-trust-ssh-host-keys-from-ui Let administrators trust SSH host keys from the web UI

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-04 14:30

## Description

With the default `ssh.host_key_verification = auto_reject`, connecting to a new SSH target fails with "the host key is unknown and unknown keys are rejected. An administrator must add it under Known hosts.", but the Known hosts page can only list and delete keys. Administrators need a way to trust a target's host key from the UI. Acceptance: an administrator can fetch a target's host key through the gateway, compare its fingerprint and trust it; a key can also be pasted manually; afterwards the connection succeeds without changing the verification mode.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- `POST /admin/api/ssh/known-hosts` (`add_ssh_known_host`) already stores `{ host, port, key_type, key_base64 }`; the web client and the Known hosts page (`admin-known-hosts-page.tsx`) have no add action.
- The SSH client already reports the server key (`RCEvent::HostKeyReceived` / `HostKeyUnknown`), so the gateway can read a host key without authenticating.
- `ssh.host_key_verification` (`prompt|auto_accept|auto_reject`, default `auto_reject`) is only in `config.yaml`; `prompt` lets the web terminal user confirm the key in a dialog.

Proposed plan:
1. API: `POST /admin/api/ssh/known-hosts/scan { host, port }` connects through the gateway, reads the host key without signing in and returns `{ key_type, key_base64, fingerprint, known }`. Admin only, with a short timeout.
2. Known hosts page: an "Add host key" dialog with host and port; "Fetch from host" fills in the key and shows its SHA256 fingerprint for comparison; or paste a `known_hosts` / `ssh-keyscan` line. "Trust" saves it through the existing add endpoint.
3. Target detail (SSH): when the target has no known key, a "Trust host key" action that opens the same dialog with host and port filled in. The terminal error for an unknown key links administrators there.
4. Tests: Rust test for the scan against the test SSH server, web tests for the dialog, integration test that a scanned and trusted key lets the terminal connect; docs, changelog.

Decisions during implementation:
- The scan endpoint already existed (`POST /admin/api/ssh/check-host-key`, used by integration tests only); it gained `fingerprint` instead of a new `/scan` route.
- The terminal error links by text: the unknown-key message now names Known hosts and the target's Security tab, rather than a clickable link.
- The add endpoint dedupes identical keys, so fetching and trusting twice does not create duplicates.
