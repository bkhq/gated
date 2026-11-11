# 20261111-1122-ssh-public-key-satisfies-otp-policy SSH asks for password and OTP although the client key is registered

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-11 11:22

## Description

A user whose public key is registered is still asked for a password and a one-time password when connecting over SSH. Acceptance: a registered key signs in on its own, with no further prompt, also for users who have enrolled OTP; keys pasted with a comment work.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- Enrolling OTP (`api_create_otp`) calls `UserRequireCredentialsPolicy::upgrade_to_otp`, which sets the SSH policy to `[Password, Totp]` whenever the user has a password *or a public key*. The SSH policy is an `AllCredentialsPolicy`, so a public key never satisfies it: the client's key is validated, the server answers "need password", the client falls back to password, then keyboard-interactive asks for the OTP. A key-only user cannot sign in at all after enrolling OTP.
- Self-service key registration (`/api/profile/credentials/public-keys`) stores the pasted line verbatim. `validate_credential` compares the exact string `"<type> <base64>"`, so a key saved with its comment (`... user@laptop`) or trailing whitespace never matches. The admin endpoint normalises (`set_comment("")`, `to_openssh`); the self-service one does not.
- Without OTP and with the key stored normalised, key login works (`AnySingleCredentialPolicy`).

Proposal:
1. SSH policy: a valid public key satisfies the SSH policy on its own, unless the required set itself names `PublicKey` (then the administrator asked for key *plus* another factor). Implemented as a wrapper around the SSH `AllCredentialsPolicy` in `get_credential_policy`; HTTP, MySQL and PostgreSQL are unchanged. This mirrors OpenSSH `AuthenticationMethods publickey password,keyboard-interactive`.
2. Key matching: `validate_credential` parses the stored key and compares key bytes, so keys already stored with a comment start working without a migration. Self-service registration normalises like the admin endpoint and rejects unparsable keys with 400.
3. Tests first: policy unit tests (`gated-common`), key comparison unit test (`gated-core`), an SSH integration test (`tests/ssh`) for a user with OTP enrolled signing in with the key only, and a key registered with a comment.
4. Docs: operations notes on what OTP enrollment means for SSH; changelog.

## Outcome

`PublicKeyOrPolicy` (`gated-common/src/auth/policy.rs`) wraps the SSH `AllCredentialsPolicy`: a valid public key is sufficient unless the required set names `PublicKey`; it is offered in `Need` when the user has a key. Stored keys are compared as `<type> <base64>` (`normalized_public_key` in `config_providers/db.rs`) and self-service registration normalises like the admin endpoint (400 for unparsable keys). Covered by unit tests in all three crates and `tests/ssh/auth-pubkey-otp.test.ts` (policy `[Password, Totp]`, key stored with a comment, `BatchMode=yes` login). Operations docs and changelog updated.
