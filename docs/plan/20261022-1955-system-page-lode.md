# 20261022-1955-system-page-lode Group settings into tabs with lode-backed update, security and about

- **status**: completed
- **createdAt**: 2026-10-22 19:55
- **approvedAt**: 2026-10-22 20:05
- **relatedTask**: 20261022-1955-system-page-lode

## Context

- lode integration today is readiness only: `crates/gated/src/lode.rs` writes `state.ready` under `state.json.lock` when `LODE_READINESS=state`. `deploy/lode/` has a demo `lode.toml` (`policy = "check"`) and Dockerfile.
- lode's app contract (`/srv/bkhq/lode/docs/integration.md` §2): lode writes `current`, `last_good`, `available`, `status`, `last_check`, `last_error`, `checked_nonce`, `check_error`; the app requests with `target` (version or `"latest"`), `restart_nonce`, `check_nonce`. Detection: `LODE_DIR` + `LODE_INSTANCE` in the environment. Writes are read-modify-write under `state.json.lock` (gated already does this for `ready`).
- Encryption lock exists: `POST /api/admin/encryption/lock` closes the DB and returns to the unlock screen; the Settings page hosts `EncryptionAdminCard` (status, lock now, change master password).
- Version and gateway host sit at the bottom of the user menu (`user-menu.tsx`), shown as `vv0.23.0-…` because `gated_version()` already carries the `v`; the menu also renders two adjacent separators.
- Session tabs show a fixed accent dot regardless of connection state; the terminal status bar already knows connecting / connected / failed.

## Proposal

Backend (`gated-admin`, `gated`):

1. Extend `lode.rs` with `status()` (plain read of `state.json`) and `request(edit)` (RMW under the lock, as `write_ready` does) for `check_nonce`, `target` and `restart_nonce`. No SDK vendoring; no new dependencies.
2. Admin API `/admin/api/system` (utoipa, admin only, audited):
   - `GET /system` → `{ version, external_host, listeners: {admin, ssh, mysql, postgres, http}, encryption: status, lode: { instance, current, last_good, available, status, last_check, last_error, check_error } | null }`
   - `POST /system/update-check` → bumps `check_nonce`, returns the nonce; the UI polls `GET` until `checked_nonce` reaches it.
   - `POST /system/update` `{ version? }` → sets `target` (default `available`).
   - `POST /system/restart` → bumps `restart_nonce`.
   - All three return `409 not_supervised` when gated is not running under lode. Update and restart require a password/OTP step-up (reusing the 15-minute window).
3. Lock stays the existing encryption endpoint.

Frontend:

4. Settings page (`/admin/params`) becomes tabs, selected by `?tab=`: General (site title, minimize password login, own credential management), Sessions (transfer rate, SQL console limits, terminal watermark), SSH authentication (client auth methods), Update (lode status; check / update to `available` / restart with confirmation, progress while lode reports `updating`/`starting`, reconnect afterwards; "not managed by lode" otherwise), Security (the existing encryption card: lock now, change master password), About. The three parameter tabs share one form and one save button.
5. About is also a standalone page `/about` open to every signed-in user (version, gateway host, listener ports from `/api/info`); the settings About tab renders the same panel.
6. User menu: drop the version/host footer and the duplicate separator; add an "About" row linking to `/about` for everyone.
7. Session tab dot reflects the connection: connecting = muted, connected = accent, failed = destructive (red).
8. i18n `en` / `zh-CN`, OpenAPI snapshot and generated types, `docs/api.md`.

Local verification:

9. Run the local dev instance under lode (`/srv/bkhq/lode`, built in a sibling container): `lode-cli seed` installs two local builds (current and a newer one) into a local manifest feed, so check → update → restart can be exercised end-to-end through nsl.

Tests: Rust unit tests for the `state.json` reads/requests (lock + preserve lode fields) and the API's not-supervised / step-up paths; integration test with a fake `LODE_DIR` (request fields written, status read back); web tests for the Update tab states, settings tabs, About page and tab status dot.

## Risks

- A restart/update drops every live session (SSH, SQL, web terminals); the confirmation dialog states this.
- With encryption enabled, every restart or update lands on the unlock screen and needs the master password.
- Rollback is out of scope (decided 2026-10-22); lode rolls back failed versions by itself.
