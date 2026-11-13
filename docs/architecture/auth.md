# Authentication and Authorization

English | [简体中文](auth.zh-CN.md)

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

A user's role assignment can carry `expires_at` (`user_roles.expires_at`,
set in the user dialog or with `PUT /admin/api/users/:id/roles/:role_id`).
An expired assignment grants nothing: the user's roles are always read
through `User::Model::active_roles` or the `UserRoleAssignment::unexpired`
condition (target access, file transfer, account resolution, role-scoped
command rules, the admin check). The row is kept, so the administrator sees
it as expired and can extend or remove it. `watch_role_expiry`
(`crates/gated/src/commands/run.rs`) looks for newly expired assignments
every 15 seconds and triggers `Services::revalidate_sessions`, which closes
the sessions the assignment admitted. Roles assigned by SSO role mappings
are added without an expiry.

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

- A ticket narrows the user's access to one target; it never replaces the
  user's own grant. Creation requires the grant, every use rechecks it, and
  `Services::revalidate_sessions` closes a ticket session when the user loses
  it.
- Creation (admin API) verifies that the user and target exist, that the user
  is authorized for the target, that `expiry` is in the future and
  `number_of_uses` is positive, generates 32 random bytes hex-encoded
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
- A ticket session is listed with the browser sessions and can be revoked
  there. It ends when its ticket is deleted or expires; an open web terminal
  is closed within 10 seconds. It cannot use `/api/profile/*`.
- Tickets name their user and target. Deleting a user or a target deletes
  its tickets; renaming one moves the tickets to the new name and ends
  ticket sessions opened under the old one.

## Failed login throttling

`gated_core::auth_throttle` counts failed password and OTP attempts from
every listener (SSH, MySQL, PostgreSQL, web login) in one bounded in-memory
table with a 5-minute window. Once a counter is full, further attempts are
answered as a wrong credential without being checked:

| Counter | Limit per window |
|---|---|
| password, per (user, client address) | 10 |
| password, per client address | 60 |
| password, per user | 100 |
| OTP, per user | 10 |

Public keys, certificates and SSO are not counted. The web login keeps its own
per-attempt limiter in addition. Counters are per process and reset on
restart.

### Login protection

Behind those counters, `gated_core::login_protection` keeps failed password
and OTP attempts in the database (`failed_login_attempts`) and turns them
into address blocks (`ip_blocks`) and user lockouts (`user_lockouts`) that
survive a restart and that an administrator can list and lift (Settings >
Security, `/admin/api/login-protection/*`). Thresholds are in `parameters`
(`login_protection` in the parameters API); it is on by default.

- An address is blocked after `ip_max_attempts` failures (20) within
  `ip_window_seconds` (15 minutes), whatever the user names. The first block
  lasts `ip_block_seconds` (30 minutes); each further block within 24 hours
  of the last one doubles, up to `ip_max_block_seconds` (24 hours).
- A user is locked out after `user_max_attempts` failures (10) within
  `user_window_seconds` (1 hour), from any address, for
  `user_lockout_seconds` (1 hour; `0` = until lifted). Unknown names are not
  locked. Users with the `admin` role are never locked out, since anyone who
  knows the name could otherwise keep them out; address blocks and the
  in-memory per-user limit still apply to them.
- While blocked or locked, password and OTP attempts are answered as a wrong
  credential without being checked. Public keys, certificates, SSO, tickets
  and API tokens are not affected and not counted. Attempts under a name
  that does not exist count towards the address (SSH: password attempts
  only, not key offers).
- A successful sign-in does not clear earlier failures; they leave the count
  when the window passes.
- The client address is the TCP peer. On the web login with
  `trust_x_forwarded_headers`, it is the last entry of `X-Forwarded-For`,
  the one the nearest proxy appended; earlier entries are client-supplied.
  Behind two or more proxies that entry is the outer proxy, and all users
  share one block: raise `ip_max_attempts` or switch the protection off in
  that setup.
- Ways back in when locked out: the admin token (not subject to blocks) or
  `gated recover-access`, which lifts the chosen user's lockout and all
  address blocks.
- Audit events: `login_ip_blocked`, `login_user_locked`, `auth_refused`.

### Allowed addresses of a user

A user can be limited to IP addresses and CIDR ranges (`users.allowed_ip_ranges`,
edited in the user dialog or with `PUT /admin/api/users/:id`). With a list set,
the user is refused from any other address, and from an address that cannot be
determined:

| Path | Where it is checked | Answer outside the ranges |
|---|---|---|
| Interactive sign-in on SSH, MySQL, PostgreSQL, web login and SSO | `AuthStateStore::create` | as for an unknown user |
| Tickets on every listener, `POST /api/tickets/claim`, `?gated-ticket=` | `authorize_ticket` | as for an unknown ticket |
| API tokens on the management API and the HTTP proxy | after `validate_api_token` | as for an unknown token |

The client address is derived as for login protection. A browser session
that already exists is not ended when the list changes or the client moves
to another address; end it from the sessions page if needed. Audit events:
`auth_address_not_allowed`, `ticket_address_not_allowed`,
`api_token_address_not_allowed`.

### Required MFA

`parameters.mfa_required` (Settings > Security, off by default) makes an OTP
device mandatory for every user, including users who sign in through SSO. A
user is "enrolled" once at least one OTP device is stored.

| Path | Not enrolled | Enrolled |
|---|---|---|
| Web sign-in (password or SSO) | signs in with the stored policy, then reaches only the enrollment | must present an OTP code, whatever the stored credential policy says (`RequiredFactorPolicy`) |
| Management API with a session or a user API token | `403` with the header `X-Gated-Mfa-Setup-Required: 1`, except the allow-list below | unchanged |
| SSH, MySQL, PostgreSQL sign-in | refused in `AuthStateStore::create`, answered like an unknown user | the stored credential policy applies |
| HTTP proxy with an API token or a client certificate | `401` | unchanged |

Open to a user who still has to enroll (`mfa_setup_allows`): the pages under
`/ui`, `GET /api/info`, the sign-in, sign-out, SSO and session endpoints
under `/api/auth` and `/api/sso`, the boot gate endpoints, and
`POST /api/profile/credentials/otp/begin` and `POST /api/profile/credentials/otp`.
The two enrollment calls work even when users may not manage their own
credentials. `/api/info` reports `mfa_setup_required`; the web interface then
shows the enrollment instead of the application.

Not covered: ticket sessions and the admin token are not user accounts and
are not gated. After enrollment the second factor is enforced at web sign-in
only; SSH follows the stored policy (enrollment puts `Totp` on it, and a
registered public key still signs in alone), and the database protocols have
no second factor. A user's last OTP device cannot be removed through
`DELETE /api/profile/credentials/otp/:id` while MFA is required. An
administrator can still remove it, and `gated recover-access` removes the
devices of the user it recovers; either way the user enrolls again at the
next web sign-in. Until then the account is protected by its first factor
only, as is any account that has not enrolled yet. Audit event:
`auth_mfa_setup_required`.

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
  max-age (30 min default) and host-scoped cookie validation. The session
  identifier is replaced at sign-in.
- **Revocation on identity changes** (`end_user_sessions`,
  `crates/gated-admin/src/http_service/session.rs`): a user's browser
  sessions end and their proxy sessions are closed when an administrator
  sets or removes their password, removes an OTP, public key, SSO or
  certificate credential, removes the `admin` role, renames or deletes the
  user. A credential change keeps the session that made it. Sessions are
  matched by user id.

## Failed-auth behavior

There is no account lockout. The SSH listener applies russh's 1-second delay
after a failed attempt; auth outcomes are counted in the
`gated_auth_attempts_total` metric (labels `result`, `method`,
`crates/gated-core/src/metrics.rs`). Per-user and per-target
`rate_limit_bytes_per_second` settings limit data transfer, not
authentication attempts.
