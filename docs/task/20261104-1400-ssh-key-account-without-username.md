# 20261104-1400-ssh-key-account-without-username Let SSH key accounts take the username from the target

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-04 14:00

## Description

One SSH key is often installed for different login users on different hosts. An `ssh-key` account should be usable without a username, taking it from the target it is bound to. Acceptance: an `ssh-key` account can be saved with an empty username; connecting through a target with such an account uses the target's username; an account with a username keeps overriding the target as today.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- `gated_core::account_credentials::ssh_options_with_account` always replaces the target username with the account's (`options.username = credentials.username`), for the native SSH path and the web terminal alike.
- `validate_credentials` in `crates/gated-admin/src/api/accounts.rs` requires `username` for `ssh-key`; the account form marks it required.
- The target form already has a username field for SSH targets.

Proposed plan:
1. Backend: `ssh-key` username optional; in `ssh_options_with_account` an empty account username keeps the target's username (and the existing fallback to the gated user when that is empty too). `ssh-password` is unchanged.
2. UI: the `ssh-key` username field becomes optional with a hint ("leave empty to use the target's username"); the account view shows "from target" when empty.
3. Tests: Rust unit test for the username resolution, API validation test, account form test; docs, changelog.

Implemented as proposed; the resolution lives in `account_credentials::apply_ssh_account`. The OpenAPI schema keeps `username` required (`#[schema(required = true)]`) because responses always carry it.
