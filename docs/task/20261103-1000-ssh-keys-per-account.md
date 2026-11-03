# 20261103-1000-ssh-keys-per-account Move gateway SSH client keys into ssh-key accounts

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-03 10:00

## Description

Besides host keys, gated stores global "client" keys (Settings → SSH) and tries them for every SSH target whose public-key auth has no private key. They cannot be chosen per target or per account. The `ssh-key` account kind already carries a private key and is bound to targets, so the client keys belong there: remove the global client keys, and let admins generate a key pair or upload their own when creating an `ssh-key` account, then see its public key to install on the target. Acceptance: no global client keys or fallback remain (`ssh_keys` keeps host keys only); creating an `ssh-key` account can generate an Ed25519 (or RSA) key server-side or take an uploaded key; account views show the OpenSSH public key and fingerprint, never the private key; targets select such an account for key auth; public-key auth without a key is rejected when a target is saved; tests and docs updated.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Current code: `gated-protocol-ssh/src/{keys.rs,client/mod.rs}` (`KeyKind::Client`, `ssh_auth_keys` fallback), `gated-admin/src/api/ssh_keys.rs` (`/ssh/own-keys`, client import/generate), `gated-common/src/types/account.rs` (`SshKeyAccountCredentials`), `gated-core/src/account_credentials.rs` (bound account overrides target auth), `gated-admin/src/api/accounts.rs`, web accounts and target forms, `web/src/features/admin/config/ssh-keys-card.tsx`. 24 integration tests use `auth: { kind: "PublicKey" }` without a key and rely on the imported fixture client keys.

Proposed plan:
1. Remove `KeyKind::Client`, `/ssh/own-keys`, client import/generate and the fallback; `ssh_keys` keeps host keys (existing client rows deleted by a migration). Settings → SSH shows host keys only.
2. Accounts API: an `ssh-key` account is created with either `private_key_pem` (+ passphrase) or `generate: "ed25519" | "rsa"`; a "regenerate key" action replaces it. Account responses add `public_key_openssh` and `fingerprint` derived from the stored key.
3. Target save: public-key auth needs a bound `ssh-key` account or an inline private key; otherwise `400`.
4. Web: account form offers Generate / Upload for SSH keys and shows the public key with copy; target form unchanged apart from validation messages.
5. Tests: integration helpers create an `ssh-key` account from the `tests/ssh-keys/wg` fixture and bind it instead of importing client keys; unit and web tests for generation and public-key display. Docs en/zh-CN, changelog.

Decisions (approved 2026-11-03):
- Viewing an account's private key requires the existing step-up reveal (password or TOTP).
- Targets keep the inline private key option.
- The profile SSH key list shows the full public key with copy and its fingerprint (done in this task).
- Target save without a key or bound account returns `422` (consistent with the other target validation errors), not `400`.
- Integration targets use the fixture key inline (`sshPublicKeyAuth()`) instead of a bound account, so tests that bind their own accounts stay unchanged.
- No separate "regenerate" action: updating an `ssh-key` account with `generate` replaces the key.
