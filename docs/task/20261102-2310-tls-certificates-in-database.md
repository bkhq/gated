# 20261102-2310-tls-certificates-in-database Store listener TLS certificates in the database

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-02 23:10

## Description

The HTTP proxy, MySQL and PostgreSQL listeners read their TLS certificate and key from files named in the config (`http.certificate`/`key`, `mysql.*`, `postgres.*`), all pointing at the admin certificate written by setup. A missing file stops the process (seen after an interrupted first start). Store the listener certificates in the database instead (covered by SQLCipher when encryption is on), generate a self-signed one when a listener has none, and manage them from the admin UI. Only the admin listener keeps file-based certificates, since it must serve before the database is open; when its files are missing at start, generate a self-signed pair. Acceptance: no listener other than admin reads certificate files; missing certificates never stop startup; admins can view, import and regenerate each listener certificate in the web UI and the new certificate is served without a restart; tests cover generation, import validation, hot reload and the missing-admin-file path.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Current code: `gated-protocol-http/src/server.rs` (`SingleCertResolver`), `gated-protocol-{mysql,postgres}/src/lib.rs`, `gated-admin/src/http_service/mod.rs` (admin + SNI files), `gated/src/commands/setup.rs`, `gated-core/src/healthcheck.rs`. Precedent: SSH keys in `ssh_keys` (`20261102-1900`).

Proposed plan:
1. Migration `m00014_tls_certificates` + entity (`kind` http|mysql|postgres, `certificate_pem`, `private_key_pem`, `created`). Remove the `certificate`/`key` fields from the `http`, `mysql` and `postgres` config sections (development phase, no compatibility).
2. `gated-core` TLS store: load per kind, generate self-signed (SANs: `external_host`, `localhost`) when missing at listener start, import validates that the key matches the certificate. Listeners use a shared resolver whose certificate is swapped on import/regenerate, so changes apply without a restart.
3. Admin keeps `admin.certificate`/`key` + `sni_certificates` files; `run` generates the admin pair if the configured files are missing. Setup still writes it.
4. Admin API (OpenAPI): `GET /tls/certificates` (kind, subject, SANs, validity, SHA-256 fingerprint), `PUT /tls/certificates/{kind}` (import PEM cert chain + key), `POST /tls/certificates/{kind}/generate` (replace with a new self-signed one).
5. Web: Settings card listing the three certificates with import and regenerate; i18n en/zh-CN.
6. Tests: Rust unit/API tests; integration data-dir (no listener cert files; deleting admin files is recovered on restart; imported cert is served by the HTTP proxy); web card test. Docs en/zh-CN, config schema, changelog.

Decision (user, 2026-11-02): three independent certificates (HTTP proxy, MySQL, PostgreSQL); hot reload.
