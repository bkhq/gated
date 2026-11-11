# 20261111-1425-ticket-session-profile-escalation Keep ticket sessions out of the profile API

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-11 14:25

## Description

A browser session created by claiming a ticket is meant to reach one target. The self-service profile endpoints do not check for it, so a ticket holder can call `POST /api/profile/api-tokens` (`http_service/api/api_tokens.rs:100`) and receive an API token for the ticket's user. The token is not target-scoped: it reaches every target of that user and, for an admin user, `/admin/api`. The same gap lets a ticket session issue and revoke certificates, delete public keys and OTP credentials (which also downgrades the MFA policy), delete tokens and tickets, and read `/api/profile/{credentials,api-tokens,tickets,sessions}` (`credentials.rs:553,727,787,851`).

Acceptance:
- Every `/api/profile/*` route answers 403 to a ticket session; the check lives at the router layer so a new route cannot miss it.
- Self-service token `expiry` is validated (not in the past, bounded).
- Regression tests cover token creation, credential deletion and the read endpoints from a ticket session.

## ActiveForm

Blocking ticket sessions from the profile API

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Reproduced against the release binary: a ticket for target `bound` minted a token that listed target `other` and got 200 from `/admin/api/users`.
