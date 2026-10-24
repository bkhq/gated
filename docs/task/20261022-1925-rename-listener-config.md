# 20261022-1925-rename-listener-config Rename the admin and HTTP-proxy listener config sections

- **status**: completed
- **priority**: P2
- **owner**: worker/gated-config-1022
- **createdAt**: 2026-10-22 19:25

## Description

The `http` section configured the admin UI/API listener and `proxy` the HTTP reverse-proxy listener. Rename them to match what they serve. Acceptance (approved 2026-10-22, no compatibility layer because nothing is deployed yet):

- `http` → `admin` (`AdminConfig`), `proxy` → `http` (`HttpConfig`); the deprecated `web_admin` section now migrates to `admin`.
- CLI `--http-port` (`run`, `unattended-setup`) → `--admin-port`.
- config-schema.json, local `config.yaml`, integration tests, scripts and docs follow the new names.

## ActiveForm

Renaming the listener config sections

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- complete: Rust workspace tests, web suite, tests/http-proxy, tests/http/info, tests/http/rbac-http-access and tests/misc/encryption-lifecycle pass
