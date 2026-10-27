# Authentication and Authorization

All protocols funnel into one credential model, one auth state machine, and
one authorization check, implemented in `gated-common` (types),
`gated-core` (state store + DB-backed config provider), and `gated-sso`
(OIDC).

## Credential types

`CredentialKind` (`crates/gated-common/src/auth/cred.rs`) enumerates:
`Password`, `PublicKey`, `Certificate`, `Totp`, `Sso`, `WebUserApproval`.
`AuthCredential` (`cred.rs`) is the runtime value submitted during
authentication (OTP code, password secret, offered public key, certificate
PEM, SSO provider+email pair, or a web approval marker).

Storage (one SeaORM entity per kind, all in `crates/gated-db-entities/src/`):

| Kind | Entity | Stored as |
|---|---|---|
| Password | `PasswordCredential` | Argon2 hash |
| Public key | `PublicKeyCredential` | OpenSSH public key + `last_used` |
| Certificate | `CertificateCredential` | issued certificate PEM (see [tls-and-ca.md](tls-and-ca.md)) |
| TOTP | `OtpCredential` | secret key bytes |
| SSO | `SsoCredential` | provider name + email |
| Web approval | none | granted live via the web session |

## Auth state machine

An `AuthState` (`crates/gated-common/src/auth/state.rs`) accumulates
validated credentials for one login attempt and asks its `CredentialPolicy`
whether they are sufficient. `verify()` (`state.rs`) returns an
`AuthResult` (`state.rs`): `Accepted`, `Need(set-of-kinds)`, or
`Rejected`.

Policies (`crates/gated-common/src/auth/policy.rs`):

- `AnySingleCredentialPolicy` (`policy.rs`) — any one valid credential
  suffices (the default);
- `AllCredentialsPolicy` (`policy.rs`) — all listed kinds required;
- `PerProtocolCredentialPolicy` (`policy.rs`) — distinct requirements per
  protocol (HTTP / SSH / MySQL / PostgreSQL) with a default fallback.

The effective policy per user is built by
`ConfigProvider::get_credential_policy`
(`crates/gated-core/src/config_providers/db.rs`): it collects the kinds
the user actually possesses (always adding `WebUserApproval`) and overlays
the user's stored `UserRequireCredentialsPolicy`, if any, as per-protocol
`AllCredentialsPolicy` requirements.

In-flight states live in the `AuthStateStore`
(`crates/gated-core/src/auth_state_store.rs`), keyed by UUID, created via
`create()` (`auth_state_store.rs`), vacuumed periodically, and observable
through a broadcast channel.

### Web approval of non-web logins

When a policy demands `WebUserApproval`, the protocol session (SSH
keyboard-interactive, PostgreSQL) presents a browser URL containing the auth
state id. The user, logged into the portal, sees pending attempts
(`all_pending_web_auths_for_user`, `auth_state_store.rs`) and approves
one, which appends `AuthCredential::WebUserApproval` to the state
(`crates/gated-admin/src/http_service/api/auth.rs`); the waiting protocol
session is notified through the store's broadcast channel and re-verifies.

## SSO / OIDC (`crates/gated-sso`)

Providers are configured under `sso_providers` as
`SsoInternalProviderConfig` (`crates/gated-sso/src/config.rs`): `Google`,
`Apple` (key id + team id), `Azure` (tenant), or `Custom` (issuer URL,
scopes, optional role mappings, audience options).

Login flow:

1. `SsoClient::start_login` performs OIDC discovery and builds an
   authorization-code request with PKCE (except Apple) plus CSRF token and
   nonce (`crates/gated-sso/src/sso.rs`).
2. The HTTP portal redirects the browser to the IdP; the callback returns to
   gated, where `SsoLoginRequest::verify_code` exchanges the code, validates
   ID-token claims, optionally fetches userinfo, and extracts
   `preferred_username`, `email`, `name`, `email_verified`
   (`crates/gated-sso/src/request.rs`).
3. A custom `gated_roles` claim (string or array,
   `crates/gated-sso/src/sso.rs`, read at `request.rs`) carries
   group/role names from the IdP.

Role mapping: the callback handler translates remote names through the
provider's `role_mappings` and calls
`ConfigProvider::apply_sso_role_mappings`
(`crates/gated-core/src/config_providers/db.rs`), which adds and removes
`UserRoleAssignment` rows so managed roles mirror the IdP on every login.
Single logout is supported when the provider metadata exposes
`end_session_endpoint`.

## RBAC

Three entities form the authorization model
(`crates/gated-db-entities/src/`): `Role`, `UserRoleAssignment`,
`TargetRoleAssignment`. `ConfigProvider::authorize_target`
(`crates/gated-core/src/config_providers/db.rs`) loads the role sets of
the user and the target and grants access when the intersection is
non-empty. Every protocol calls this after authentication and before
connecting to the target.

The built-in `admin` role (`BUILTIN_ADMIN_ROLE_NAME`,
`crates/gated-core/src/consts.rs`) is created at database bootstrap and
gates the admin API: `require_admin`
(`crates/gated-admin/src/http_service/common.rs`) checks that the
session user holds it.

## Tickets

A ticket is a pre-authorized, single-purpose secret bound to a (user,
target) pair — useful for handing out scoped access without sharing real
credentials. Entity (`crates/gated-db-entities/src/Ticket.rs`):
`secret` (stored as a hash), `username`, `target`, optional `uses_left`
counter (null = unlimited), and optional `expiry`.

- Creation (admin API) verifies the named user is authorized for the target,
  generates 32 random bytes hex-encoded
  (`crates/gated-common/src/helpers/hash.rs`), and returns the secret once.
- Consumption: `authorize_ticket`
  (`crates/gated-core/src/config_providers/mod.rs`) hashes the presented
  secret, matches the digest and enforces expiry/use count; `consume_ticket`
  atomically decrements a limited `uses_left`.
- Protocol entry points: SSH/MySQL/PostgreSQL usernames of the form
  `ticket-<secret>`; the web portal accepts a `gated-ticket` query parameter
  handled by `ticket_middleware`
  (`crates/gated-admin/src/http_service/middleware/ticket.rs`), which
  establishes a session restricted to the ticket's target. The HTTP reverse
  proxy listener does not accept tickets.

## API tokens and web sessions

- **API tokens** (`crates/gated-db-entities/src/ApiToken.rs`): per-user
  labeled secrets with expiry, stored as hashes and validated by
  `ConfigProvider::validate_api_token`
  (`crates/gated-core/src/config_providers/db.rs`). Accepted as
  `Authorization: Bearer` on the HTTP reverse proxy and as `X-Gated-Token`
  on the portal/admin APIs.
- **Admin token**: `gated run --enable-admin-token` maps the
  `GATED_ADMIN_TOKEN` environment value to the first admin user — used by
  automation and the e2e harness.
- **Web sessions**: cookie `gated-http-session`
  (`crates/gated-admin/src/http_service/common.rs`), server-side
  session storage, with separate cookie max-age (24 h default) and session
  max-age (30 min default) and host-scoped cookie validation.

## Failed-auth behavior

There is no account lockout. The SSH listener applies russh's 1-second delay
after a failed attempt; auth outcomes are counted in the
`gated_auth_attempts_total` metric (labels `result`, `method`,
`crates/gated-core/src/metrics.rs`). Per-user and per-target
`rate_limit_bytes_per_second` settings limit data transfer, not
authentication attempts.
