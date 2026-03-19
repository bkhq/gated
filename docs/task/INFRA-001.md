# INFRA-001 Full repository audit and documentation cleanup

- **Priority:** P1
- **Status:** completed
- **Owner:** roy
- **Created:** 2026-03-19
- **Completed:** 2026-03-19

## Description

Perform a full security, code quality, and documentation audit of the Gated repository after the project rename from Warpgate and frontend modernization.

## Findings

49 total findings: 8 critical, 10 high, 14 medium, 17 low.

### Critical (P0)

1. Cookie `.secure(false)` hardcoded — `gated-protocol-http/src/lib.rs:272`
2. Docker includes `.git/` directory — `docker/Dockerfile:17`
3. TLS certificate verification can be disabled — `gated-tls/src/rustls_helpers.rs:33-37`
4. i18n `escapeValue: false` — `gated-web/src/app/i18n.ts:23`
5. All 57 route components are placeholders — `gated-web/src/features/`
6. OpenAPI client not generated — `gated-web/src/features/*/lib/api.ts`
7. README build commands incorrect (npm instead of bun)
8. Dockerfile uses npm instead of bun

### High (P1)

1. RUSTSEC advisories allowed without justification — `deny.toml:69-73`
2. Native cert loading can panic — `gated-tls/src/rustls_root_certs.rs:8-10`
3. TLS 1.2 still enabled — `Cargo.toml:39`
4. Cookie domain falls back to Host header — `cookie_host.rs:41-99`
5. Auth flow completely unimplemented in frontend
6. 6+ unused frontend dependencies
7. xterm.js terminal unimplemented
8. GitHub Actions version pinning inconsistent
9. Missing root .editorconfig
10. FUNDING.yml references upstream project

## Deliverables

- [x] NOTICE file created
- [x] README.md updated
- [x] CLAUDE.md updated
- [x] FUNDING.yml fixed
- [x] architecture.md CI/CD section corrected
- [x] changelog.md updated
- [x] Audit report delivered
