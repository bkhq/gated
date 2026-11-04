# 20261104-2130-per-role-target-accounts Let one target sign in with a different account per role

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-04 21:30

## Description

A target may have several upstream accounts, and different user groups (roles) should sign in with different ones, e.g. developers as `deploy`, DBAs as `root`. Acceptance: an admin maps roles to accounts on a target; a connection (web terminal, file manager, native SSH/MySQL/PostgreSQL clients) signs in with the account of the user's granting role; the session and audit record which account was used.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- `target_accounts (target_id, account_id, role)` already allows several accounts per target, `role` ∈ `primary | fallback | readonly`, but every connection path only reads `primary` (`gated-core/src/account_credentials.rs` `primary_account_credentials`); `fallback` and `readonly` are stored and never used.
- Access is `target_roles (target_id, role_id)`; `authorize_target` allows a user when their roles intersect the target's roles.
- Native clients pick the target in the login name: `<user>:<target>` or `<user>#<target>` (`gated-common/src/auth/selector.rs`).

Proposed plan (option A, recommended):
1. Schema: `target_roles.account_id` (nullable FK to `accounts`, restrict on delete). Null keeps today's behaviour: the target's primary account, else the target's inline credentials.
2. Resolution at connect time: take the user's roles that grant the target and their accounts. None → primary account. One distinct account → use it. Several → the user chooses: web terminal and file manager show an account picker before connecting; native clients add it to the login name, `<user>:<target>:<account>`; without it the connection is refused with the list of choices.
3. Admin UI: the target's access tab gets an account column per role (accounts of the target's kind only); the role and account pages show the mapping.
4. Sessions record `account_id`; the audit entry context and session details show the account name.
5. Tests for each resolution branch (none / one / several / explicit choice / choice not allowed for the user's roles), migrations up/down, integration tests for SSH and the web terminal; docs and changelog.

Option B (not recommended now): a separate authorization-rule entity (users or roles × targets × accounts, with validity windows), as in JumpServer. More flexible, but it replaces the role model and touches every authorization path.

Open questions (resolved at approval):
- Several matching accounts: the user chooses.
- The unused `fallback` / `readonly` binding roles are kept.

Outcome:
- Migration `m00017_target_role_accounts` adds the nullable `target_roles.account_id` (no foreign key: SQLite cannot add one to an existing table); unbinding an account from the target clears it. Admin API `GET /targets/:id/role-accounts` and `PUT /targets/:id/roles/:role_id/account`; the permissions tab has a per-role "Sign in as" select.
- `gated-core::account_credentials::select_login` resolves the login (none → default, one → it, several → the user's choice, a name the roles do not map → refused). SSH, MySQL and PostgreSQL sessions, the web terminals, SFTP and the SQL console all use it; DB pools are keyed by (target, login).
- Native selector `<user>:<target>:<account>`; web paths take `?account=`, and `GET /api/targets/:name/accounts` drives a picker shown before the terminal, file manager or SQL console connects.
- The account used is recorded as a `Target account selected` audit entry with the session context instead of a sessions column.
- Limitations: HTTP targets use the default login; the inline-credential login cannot be named, so it is reachable only when it is the user's only choice.
- Tests: core resolution unit tests, selector parsing, admin unbinding test, web gate/socket/ref tests, integration test `tests/ssh/per-role-accounts.test.ts`.
