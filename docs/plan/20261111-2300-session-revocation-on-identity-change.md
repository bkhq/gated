# 20261111-2300-session-revocation-on-identity-change Revoke sessions when a user's credentials or identity change

- **status**: completed
- **createdAt**: 2026-11-11 23:00
- **approvedAt**: 2026-11-11 23:00 (owner instruction to handle all remaining audit tasks)
- **relatedTask**: 20261111-1425-session-revocation-on-identity-change

## Context

Browser sessions store a username and are resolved by name on every request; tickets store a username and a target name. Only the self-service password change revoked sessions. An administrator resetting a password, removing a credential, renaming or deleting a user left that user's sessions alive, and a user or target created later under the same name inherited the old sessions and tickets. The session cookie value was kept across sign-in.

## Proposal

1. `end_user_sessions` (`http_service/session.rs`) ends browser sessions and closes proxy sessions by user id. It replaces the username-based helper used by the self-service password change.
2. Admin handlers call it after: password create/delete, OTP / public key / SSO / certificate credential delete (the acting session is kept), removal of the `admin` role, user rename and user delete.
3. Tickets: deleted with their user or target; moved to the new name on rename. A ticket session ends when its ticket no longer carries the names the session was opened with.
4. `Session::renew` makes the session middleware drop the old identifier and issue a new cookie; called when a user or ticket session is authorized.

## Decision: no id columns on tickets

The task suggested binding tickets and sessions to ids through a migration. The same guarantee is reached without a schema change: sessions are revoked by the user id already held in the session handle, and every operation that changes what a name refers to (rename, delete) updates or removes the tickets in the same request. Names can no longer be re-bound, and `tickets` keeps its current shape for the API and the audit views.

## Risks

- An administrator who edits another user's credentials signs that user out everywhere, including open SSH and database sessions.
- Renaming a user signs them out; they sign in again under the new name.
- A request racing a sign-in with the old cookie loses its session.
- Adding an OTP, public key, SSO or certificate credential does not end sessions.

## Scope

`crates/gated-admin/src/http_service/{session,common}.rs`, `http_service/api/credentials.rs`, `api/{users,targets,password_credentials,otp_credentials,public_key_credentials,sso_credentials,certificate_credentials}.rs`, `crates/gated-core/src/config_providers/mod.rs`, `docs/architecture/auth(.zh-CN).md`, `tests/http/identity-change-revocation.test.ts`.

## Alternatives

Add `user_id` / `target_id` columns to `tickets` with a data migration: a larger change touching the ticket API, the SSH/database ticket login path and the admin UI, for no additional guarantee.

## Verification

`tests/http/identity-change-revocation.test.ts` (7 tests) failed against the previous binary and passes: admin password reset, password removal, user delete and re-create, user rename, ticket after user/target delete and re-create, ticket through a rename, new session id at sign-in. Removal of the `admin` role and the OTP, public key, SSO and certificate paths use the same helper and have no dedicated test.
