# 20261111-1425-http-proxy-token-forwarded-upstream Strip the gateway token from proxied request URLs

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

The HTTP proxy accepts `?gated-token=<api token>` (`gated-protocol-http/src/server.rs:403`). `construct_target_url` (`engine.rs:237`) forwards the whole query string, so the account-wide API token reaches the upstream application and its access logs. The token header and `Authorization` are already stripped; the query parameter is not.

Acceptance:
- `gated-token` and `gated-ticket` (`SECRET_QUERY_PARAMS`) never appear in the upstream URL or in recorded requests.
- A unit test on `construct_target_url` and an integration test against the echo target assert it.

## ActiveForm

Stripping gateway tokens from upstream URLs

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code. Smaller items in the same handler: `resolve_target` loads every target per request and the client-certificate lookup loads every certificate credential; both should query by key.
