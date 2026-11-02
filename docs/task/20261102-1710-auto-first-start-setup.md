# 20261102-1710-auto-first-start-setup Initialize a missing config on first `run`

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-02 17:10

## Description

`gated --data-dir <dir> run` fails when `<dir>/config.yaml` does not exist, so a fresh container (Docker image, lode deployment) needs a separate `unattended-setup` step. Make `run` perform the unattended setup itself in `--data-dir` mode when the config is missing: admin port from `--admin-port` (default 8888), SSH port from `GATED_SSH_PORT` (default 2222), HTTP proxy port from `GATED_HTTP_PORT` (default 8443), external host from `GATED_EXTERNAL_HOST`, admin username from `GATED_ADMIN_USERNAME` (default `admin`), session recording on. The admin password comes from `GATED_ADMIN_PASSWORD`; when unset, a random password is generated and printed to the console (not to the log pipeline) so the operator can sign in and change it. Without `--data-dir` the existing "config does not exist" error stays. Acceptance: integration test starting `run` on an empty data dir signs in with the printed password; docs (en + zh-CN) updated.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Requested after a lode container failed with "Could not secure config: No such file or directory" on an empty data dir.
