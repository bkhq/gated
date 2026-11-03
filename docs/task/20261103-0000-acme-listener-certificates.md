# 20261103-0000-acme-listener-certificates Issue listener certificates through ACME DNS-01

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-03 00:00

## Description

Listener certificates (HTTP proxy, MySQL, PostgreSQL; task `20261102-2310`) can be generated self-signed or imported. Add ACME issuance with the DNS-01 challenge, so publicly trusted certificates (including wildcards such as `*.<http.base_domain>`) are obtained and renewed automatically. DNS records are written through an httpreq endpoint (lego `httpreq` protocol: `POST /present`, `/cleanup`) or an acme-dns server (`POST /update`); both are offered by dnsall.com (https://dnsall.com/llms.txt), where the user points `_acme-challenge.<domain>` at a CNAME target once. Acceptance: an admin configures the ACME account and DNS provider and requests a certificate per listener from the admin UI; issued certificates are stored and hot-swapped like imported ones; renewal runs automatically before expiry; failures are visible in the UI; tests run against a local ACME test server.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Proposed plan:
1. ACME client: `instant-acme` (rustls, DNS-01). Account (directory URL: Let's Encrypt production/staging or custom, contact email, account credentials) and DNS provider settings (`httpreq`: endpoint, username, password; `acme-dns`: API base, username, key, subdomain) stored in the database, encrypted with it.
2. Per listener: domains to request and a `source` (self-signed / imported / acme). Issuance: order → for each authorization present `_acme-challenge.<domain>` TXT through the provider → wait → validate → finalize with a fresh key/CSR → store chain + key → hot-swap → clean up the TXT records.
3. Renewal task: daily, renews ACME certificates with under 30 days left; last result and error kept per listener.
4. Admin API + Settings → TLS certificates: ACME settings form, per-listener "Request via ACME" (domains), status, renew now.
5. Tests: unit tests for the provider requests (mock HTTP server); integration test against Pebble + challtestsrv in a sibling container with a small httpreq shim. Docs en/zh-CN, changelog.

Decisions (user, 2026-11-03): one global ACME account and DNS provider configuration, domains per listener; the admin listener can use ACME too (the issued pair is written to its certificate files).
