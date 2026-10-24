# 20261022-1826-step-up-grace-window Keep account step-up confirmations valid for a sliding 15-minute window

- **status**: completed
- **priority**: P2
- **owner**: worker/gated-stepup-1022
- **createdAt**: 2026-10-22 18:26

## Description

Browser sessions re-enter a password or OTP for every managed-account create, update and credential reveal. After one successful confirmation, the same login session skips the prompt while the window is open. Acceptance (approved 2026-10-22):

- A successful password/OTP step-up opens a 15-minute window stored in the server-side session; logout or session expiry ends it.
- Every step-up-protected operation (create, update, reveal) inside the window succeeds without a confirmation and extends the window to 15 minutes from that operation; with no such operation the window lapses after 15 minutes.
- Operations allowed by the window are audited with confirmation `grace`.
- `GET /admin/api/accounts/step-up` reports the window end so the UI skips the prompt; the server still enforces the check.
- Unchanged: API tokens stay exempt; changing the own password still requires the current password.
- Rust tests cover window open/extend/expire and session isolation; web tests cover skipping the prompt.

## ActiveForm

Adding the step-up grace window

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- complete: window in the server-side session (`api/step_up_grace.rs`), create/update/reveal accept and extend it, status endpoint, account dialog skips the prompt; Rust, web and tests/api/accounts/crud.test.ts pass
