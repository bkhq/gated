# 20261112-1411-port-upstream-security-measures Port the security fixes and controls upstream added since the fork

- **status**: completed
- **createdAt**: 2026-11-12 14:11
- **approvedAt**: 2026-11-12 17:30
- **relatedTask**: 20261112-1411-port-upstream-security-measures

## Context

Reference: upstream Warpgate `v0.21.0..5aca27f8` (905 commits, about 220 with a security-relevant subject). Commits for features Gated does not have (RDP, VNC, LDAP, Vault, cluster nodes, admin roles, session approval, ticket requests) were left out. The rest were compared with the Gated code by reading both sides.

### Defects Gated still has

| # | Upstream | Gated today |
|---|---|---|
| A1 | `236e8047` refuse token renewal via token auth | `POST /api/profile/api-tokens` (`gated-admin/src/http_service/api/api_tokens.rs`) accepts a request authenticated by an API token, so a leaked token can mint a replacement with any expiry. |
| A2 | `e8a6ea20` TLS upgrade race | `PostgresStream::recv` reads greedily before the TLS upgrade and `upgrade` keeps `inbound_buffer`. Bytes that arrive in plaintext behind the `SslRequest` (gateway as server) or behind the `S` reply (gateway as client) are decoded after the handshake as if they had come through TLS. The MySQL stream reads one packet at a time before the upgrade and is not affected. |
| A3 | `67d25fd8` don't log ticket secrets in the handshake | `gated-protocol-mysql/src/session.rs:144` traces the whole `HandshakeResponse`: the username, which can be a ticket secret, and the auth response, which is the cleartext password under `mysql_clear_password`. |
| A4 | `e56214ae` reject non-HTTP IdP endpoints | `gated-sso` accepts whatever endpoint URLs the discovery document advertises. |
| A5 | `24c3bb6d` don't treat forwarded data as Ctrl-C | `gated-protocol-ssh/src/server/session.rs:1940` aborts a connecting session on a leading `0x03` byte on any channel, including forwarded TCP data. |
| A6 | `2c3a6e33` CSP headers | The management UI sends `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and HSTS but no `Content-Security-Policy`. |

### Controls upstream has and Gated lacks

| # | Upstream | Gated today |
|---|---|---|
| B1 | `b1f5755b`, `671ec46a`, `21636e73`, `9ca14d10`, `f8c6f9c7` login protection: IP blocks and user lockout stored in the database, admin page to list and lift them | `gated-core/src/auth_throttle.rs`: in-memory counters with fixed limits, lost on restart, not visible to administrators, no lockout that outlasts the 5-minute window. |
| B2 | `db0f15ea` password policy | No rule on password length or composition. |
| B3 | `07953d14` MFA enforcement policy | OTP is per user; no global "every user must enroll" rule. |
| B4 | `94b1712c`, `44262ebf`, `8cb33a1a` per-user allowed IP ranges, applied to tickets and API tokens too | None. |
| B5 | `50d4938a` maximum API token lifetime; `5aca27f8` endpoint allow-list for token auth | A token may have any expiry and reaches every endpoint its user reaches. |
| B6 | `cab95405`, `7c9bb8c5` role assignment expiry, sessions end when the assignment ends | Assignments do not expire. Sessions already end when a role is removed (`Services::revalidate_sessions`). |

### Already covered in Gated (no work)

Constant-time admin token check; CSPRNG for OTP keys; hashed token and ticket secrets; client `X-Forwarded-*` and the session cookie not forwarded upstream; no redirect following in the HTTP and Kubernetes proxies; upstream `Set-Cookie` domain stripped; Secure / SameSite session cookie; refusal of plaintext database auth after a TLS downgrade (MySQL and PostgreSQL); sessions ended on ticket revocation, credential change, role removal and user deletion; ticket secret rotation; checked MySQL decoders; credential ownership fixed on update; client certificates signed with SHA-384; unique usernames; encryption at rest; WebSocket Origin check; step-up for secret reveal.

Not applicable: terminal screen size cap (Gated has no `vt100` screen model), loopback prefix match (Gated parses the address), raw-HTML rendering (React escapes), `russh` GHSA-f5v4-2wr6-hqmg (Gated is on 0.63.3).

## Proposal

Two stages. Each item is test-first and lands with its own changelog entry.

### Stage A: fixes

- A1: `POST /api/profile/api-tokens` answers `403` to `RequestAuthorization::UserToken`. Test in `tests/api`.
- A2: `PostgresStream::upgrade` fails when `inbound_buffer` is not empty. This is the PostgreSQL project's own fix for the same defect; no conforming client sends data before the `S` reply. Unit tests for both directions.
- A3: trace only `database` and `auth_plugin`.
- A4: validate the scheme of every endpoint in the discovery document (`http` or `https`); unit test with a `file:` and a `javascript:` endpoint.
- A5: apply the Ctrl-C abort only to channels with a PTY; unit test.
- A6: `Content-Security-Policy` on the management UI: `default-src 'self'`, no inline script, `frame-ancestors 'none'`, the WebSocket and blob sources the terminal and file preview need. Verified by loading every page of the built UI with the header on and checking the console for violations.

### Stage B: controls

- B1 login protection. Tables `ip_blocks`, `user_lockouts`, `failed_login_attempts` (one migration); thresholds, block duration with escalation for repeat offenders and lockout duration in `parameters`; every listener reports failures (password, OTP, public key, unknown user); admin API and a Settings page to list and lift blocks and lockouts; audit events. Replaces the fixed limits in `auth_throttle.rs`; the in-memory key cap stays as the bound for the pre-database path.
- B2 password policy. Minimum length and required character classes in `parameters`; enforced on every path that sets a password (admin, profile, setup); shown in the password forms.
- B3 MFA enforcement. A `parameters` switch; a user without OTP is sent to enrollment after sign-in and can reach nothing else; native protocols refuse until enrolled. SSO users are not exempt: they enroll OTP like everyone else.
- B4 allowed IP ranges. Optional CIDR list on the user; checked at interactive login and for tickets and API tokens on every listener; malformed entries are rejected on save.
- B5 token limits. `max_api_token_duration_seconds` in `parameters`, enforced on creation; optional `http.user_api_token_allowed_endpoints` config list.
- B6 role assignment expiry. `expires_at` on `user_role_assignments`; expired assignments grant nothing; a periodic task ends the sessions they admitted through the existing revalidation.

Order within stage B: B1, B5, B2, B4, B3, B6. B1 and B4 need the client address, so the first step of B1 is to confirm how each listener derives it behind a reverse proxy.

## Risks

- A2 could break a client that pipelines before the TLS reply. None is known; PostgreSQL servers reject the same input.
- A6: a CSP that is too strict breaks the terminal, the SQL console editor or previews; too loose and it is decoration. It needs the page-by-page check.
- B1 can lock administrators out. Needs an escape hatch (the admin token or a CLI command lifts a block) and the client address must be right behind a proxy, or one proxy address gets blocked for everyone.
- B3 changes the sign-in flow for every existing user without OTP on the day it is switched on; it must be off by default.
- B1, B4, B5 and B6 add four migrations and several `parameters` columns.
- Stage B is feature work of several thousand lines across Rust, the web UI and both locales.

## Scope

Stage A: `gated-admin` (`api_tokens.rs`, `http_service/mod.rs`), `gated-protocol-postgres` (`stream.rs`), `gated-protocol-mysql` (`session.rs`), `gated-sso`, `gated-protocol-ssh` (`server/session.rs`), tests, docs. About 300 lines.

Stage B: `gated-core` (login protection service, config provider checks), `gated-db-entities`, `gated-db-migrations`, `gated-common`, all four protocol crates and `gated-admin` for failure reporting and address checks, admin and profile APIs, web settings pages and forms, locales, OpenAPI snapshots, `docs/api.md`, `docs/operations.md`, `docs/architecture/auth.md`.

## Alternatives

- **Stage A only.** Closes the defects and leaves the policy gap. Reasonable if the policy features are not wanted yet.
- **Port upstream admin roles as well.** Upstream's `9a108a44` (admins cannot edit higher-level admins) and `d47c8bed` (secret disclosure limited to target editors) depend on it. It is a permission model change of its own size and is proposed as a separate plan.
- **Keep the in-memory throttle and only add an admin view (B1).** Smaller, but blocks still vanish on restart and cannot be lifted individually.

## Annotations

Owner decisions (2026-11-12):

1. Stage A, then all of B1 to B6 in the listed order.
2. MFA enforcement applies to SSO users as well.
