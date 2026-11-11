# 20261111-1425-ssh-key-and-required-factors Decide how a self-registered SSH key relates to required factors

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

Since 20261111-1122-ssh-public-key-satisfies-otp-policy a registered public key alone satisfies an SSH policy of `[Password, Totp]` (`PublicKeyOrPolicy`, `gated-common/src/auth/policy.rs`, wired in `config_providers/db.rs`). A user can add a key from a password-only web session without step-up, so an attacker with only the password can register a key and skip the OTP an administrator required. An empty `ssh: []` policy no longer fails closed for keys.

Acceptance:
- The owner confirms or changes the trade-off; the outcome is recorded in `docs/architecture/auth.md`.
- If kept: adding a public key requires step-up with the strongest factor the user's policy names, and the user is told a key was added.
- An explicit empty SSH policy denies key login.

## ActiveForm

Reviewing SSH key versus required factors

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). The behaviour was approved by the owner on 2026-11-11; this task asks only for the registration path and the empty-policy case to be settled.

- complete: Decision (owner, 2026-11-11): keep the key-alone rule; adding a key from a browser session confirms identity (OTP when enrolled, else password; per request). Verified by tests/http/public-key-step-up.test.ts. The empty SSH policy case is not changed here; it moves to 20261111-1425-audit-minor-hardening.
