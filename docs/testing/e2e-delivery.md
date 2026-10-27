# E2E Test Delivery Guide

English | [简体中文](e2e-delivery.zh-CN.md)

How to run every test layer of the gated project, what each layer needs, what
it covers, and the gate list to run before delivering a change.

---

## 1. Test inventory

| Layer | Location | Runner | What it covers |
|---|---|---|---|
| Rust unit tests | inline `#[cfg(test)]` modules in `crates/*/src` (no crate has a separate `tests/` dir) | `cargo nextest` / `cargo test` | Pure-Rust logic per crate |
| Integration suites | `tests/` (Bun + TypeScript, drives a real `gated` binary) | `bun test` | Admin API, gateway HTTP API, SSH / MySQL / PostgreSQL / HTTP / Kubernetes proxying, command control, SFTP, SQL console, health/metrics/logs, data directory and encryption lifecycle |
| Web unit tests | `web/src/**/*.test.ts(x)` | Vitest (jsdom) | React components, hooks, API client modules, recording players, terminal codec |
| Dockerized full-stack e2e | `tests/e2e-docker/` | `tests/e2e-docker/run.sh` | Production-like container: bootstrap via admin token, then protocol probes (SSH, MySQL, PostgreSQL, HTTP headers, Kubernetes token + client cert) from sidecar containers |
| Browser (Playwright) e2e | `web/scripts/e2e-smoke.ts`, `web/scripts/e2e-auth-terminals.ts` | `bun run e2e` (smoke) / `bun scripts/e2e-auth-terminals.ts` | Real browser against a running gateway: login/session, admin forms, web terminals, ticket links |

### 1.1 Integration suites (`tests/`) in detail

Each subdirectory is a suite; `tests/package.json` defines per-suite scripts.

- `tests/api/` — admin REST API (`/admin/api`, authenticated with the
  `X-Gated-Token` header; see `tests/helpers/api-client.ts`). Subdirectories:
  `accounts/`, `auth/` (cookie auth, unauthorized), `credentials/` (password,
  OTP, public-key, certificate, SSO), `parameters/`, `roles/`, `sessions/`,
  `ssh/` (known-hosts, own-keys), `system/`, `target-groups/`, `targets/`,
  `tickets/`, `users/`; top-level files cover the RBAC matrix, the
  authentication contract, command records and recordings.
- `tests/http/` — gateway HTTP API: `/api/info`, `/api/auth/login` and its
  rate limit, OIDC security, `/api/targets` RBAC filtering, API tokens,
  ticket scoping, WebSocket origin checks.
- `tests/http-proxy/` — HTTP reverse proxy: access control, the plaintext
  listener guard, upstream TLS.
- `tests/ssh/` — SSH proxy end-to-end against a containerized sshd:
  password, OTP, public-key, ticket, and in-browser auth; failed-login audit,
  session list filters, account binding, command ACL and review, SFTP,
  RBAC, web-terminal revocation, protocol behavior (`proto.test.ts`), target
  selection, client auth config.
- `tests/db/` — PostgreSQL proxy auth (password, in-browser) driven by a real
  `psql` client, the native MySQL client through the proxy, command ACL
  filtering, multi-protocol tickets, RBAC, and the web SQL console for both
  MySQL and PostgreSQL.
- `tests/kubernetes/` — Kubernetes proxy against a `rancher/k3s` container,
  with token and client-certificate target auth, exercised through `kubectl`.
- `tests/misc/` — `/healthz` + `/readyz`, JSON log output, log injection,
  Prometheus `/metrics`, `--data-dir`, and the encryption lifecycle.
- `tests/helpers/` — shared infrastructure, not tests:
  `process-manager.ts` runs `gated unattended-setup` then
  `gated run --enable-admin-token` on random ports per test, and starts
  docker containers for sshd, MySQL, PostgreSQL, k3s, and an OIDC mock
  (`ghcr.io/soluto/oidc-server-mock:0.10.1`); `setup.ts` is preloaded by
  `tests/bunfig.toml` (fixes SSH key permissions, disables TLS verification).
- Fixtures: `tests/certs/` (TLS cert/key copied into each test data dir),
  `tests/ssh-keys/` (client/host keys; `wg/` subdir holds the gateway's own
  keys), `tests/images/` (Dockerfiles for the local `gated-e2e-ssh-server`,
  `gated-e2e-mysql-server`, `gated-e2e-postgres-server` images, built by
  `tests/Makefile`), `tests/oidc-mock/` (a standalone docker-compose variant
  of the OIDC mock on port 4011; the test helpers start their own container
  instead, so this compose file is for manual use).

### 1.2 Dockerized full-stack e2e (`tests/e2e-docker/`) in detail

`docker-compose.yml` builds `Dockerfile.bootstrapped` (a pre-bootstrapped
`gated` image with admin token enabled, recording on, fixed internal ports
8888/2222/33306/35432/36443) plus `ssh-upstream` and `mysql-upstream`
services. `run.sh` brings the stack up, runs `bootstrap.sh` through a
`curlimages/curl` sidecar, then auto-discovers and runs probes:

- top-level `probe-ssh.sh`, `probe-mysql.sh` — native `ssh`/`mysql` clients
  through the proxy, asserting that bound-account credentials win over a
  deliberately wrong inline credential;
- `scenarios/<name>/{compose.yml,bootstrap.sh,probe.sh}` — `ssh-key`,
  `postgres`, `http-headers`, `k8s-token`, `k8s-client-cert` (mTLS client
  cert presented to upstream; see `scenarios/k8s-client-cert/README.md`).

All probes run inside sidecar containers attached to the compose network
(`e2e-docker_e2e`) because host port mappings may be firewalled.

---

## 2. Prerequisites per layer

### Toolchains

- **Rust** — pinned by `rust-toolchain.toml`: channel 1.95.0 with clippy and
  rustfmt. `just` recipes default `CARGO_BUILD_TARGET` to
  `x86_64-unknown-linux-gnu` (see `justfile`).
- **Bun** — used for `web/` and `tests/` (CI pins the version in the workflows).
- **Docker** — required by `tests/` (containerized sshd/MySQL/PostgreSQL/
  k3s/OIDC mock) and by `tests/e2e-docker/` (compose + sidecars).
- **just** — command runner for the repo-root `justfile`.

### Rust unit tests

- `crates/gated-web/src/lib.rs` embeds `web/dist` via `rust-embed`, so the
  directory must exist before any workspace build. CI uses
  `mkdir -p web/dist` for test/lint jobs (`.github/workflows/ci.yml`); a real
  deliverable binary needs the actual web build (section 3).
- CI also installs `libssl-dev pkg-config` on Ubuntu.

### Integration suites (`tests/`)

- A `gated` binary. `tests/run.sh` builds
  `target/x86_64-unknown-linux-musl/debug/gated` automatically when
  `GATED_BINARY` is unset; set `GATED_BINARY=<path>` to use another
  build (CI points it at the release binary).
- Local docker images: `cd tests && make all` builds
  `gated-e2e-ssh-server`, `gated-e2e-mysql-server`, `gated-e2e-postgres-server`
  from `tests/images/` (`tests/Makefile`).
- Pulled images (fetched on first use): `rancher/k3s:v1.35.2-k3s1`
  (override with `K3S_IMAGE`), `ghcr.io/soluto/oidc-server-mock:0.10.1`
  (`tests/helpers/process-manager.ts`).
- Host binaries used by the tests themselves: `psql` and `mysql` (`tests/db/`),
  `sshpass` and `expect` (`tests/ssh/`), `kubectl` (`tests/kubernetes/`), `ssh`.
  The tests use MariaDB client options, so the CI integration job installs
  `mariadb-client` (replacing the runner's MySQL client) together with
  `openssh-client sshpass expect gnome-keyring kubectl postgresql-client`.
- Docker network: the suites start upstream containers on a `traefik` network
  and reach them by container IP; CI creates it with
  `docker network create traefik`.
- Node deps: `bun install` inside `tests/` (run.sh does this when
  `node_modules` is missing).
- Ports: allocated randomly per test by the helpers — no fixed ports to free.
- Env vars: `GATED_BINARY` (binary path), `TIMEOUT` (helper wait timeout in
  seconds, default 10; CI uses 120), `RUST_BACKTRACE=1` and
  `NODE_TLS_REJECT_UNAUTHORIZED=0` (both exported by `tests/run.sh`;
  the latter is also set by the preloaded `tests/helpers/setup.ts`).
- SSH key fixtures must be `chmod 600` (`run.sh` and `setup.ts` handle this).

### Web unit tests

- `cd web && bun install --frozen-lockfile` (or `bun install`).
- No services; Vitest runs in jsdom (`web/vitest.config.ts`,
  `web/vitest.setup.ts`).

### Dockerized full-stack e2e

- Docker with the compose plugin (`docker compose`).
- The base image `gated:e2e-build` must exist before
  `docker compose` builds `Dockerfile.bootstrapped` (its first line is
  `FROM gated:e2e-build`). No repo file records the build command for it;
  **inferred** from `tests/e2e-docker/Dockerfile.gated` (whose build context
  must be the repo root, since it does `COPY . /opt/gated`):

  ```sh
  # inferred, not recorded in the repo:
  docker build -f tests/e2e-docker/Dockerfile.gated -t gated:e2e-build .
  ```

- Host ports 18888/12222/13306/15432/16443 are mapped by the compose file but
  are not required to be reachable — probes run inside sidecars on the
  compose network.

---

## 3. How to run

### Build order

The backend embeds the frontend: `crates/gated-web` pulls in `web/dist` at
compile time. Therefore, for any binary whose UI matters (integration tests
exercising the web console, e2e-docker, release):

```sh
cd web && bun install --frozen-lockfile && bun run build   # 1. web first
cargo build                                                # 2. then backend
```

For unit tests/lints only, an empty `mkdir -p web/dist` is sufficient (this
is what CI does for the `test` and `quality` jobs).

### Rust unit tests

```sh
just test            # cargo test --target <target> --workspace --all-features
# or, as CI runs it:
cargo nextest run --profile ci --workspace --all-features --locked
cargo test --doc --workspace --all-features --locked
```

### Integration suites (`tests/`)

Easiest path (auto-builds a debug binary, installs deps, fixes key perms):

```sh
cd tests
make all             # one-time: build the three local docker images
./run.sh             # builds a debug gated if GATED_BINARY is unset, then `bun test`
```

Manual / selective:

```sh
cd tests
bun install
GATED_BINARY=target/x86_64-unknown-linux-musl/release/gated bun test --timeout 300000   # all suites
bun run test:http    # gateway HTTP API only
bun run test:ssh     # SSH suites only
bun run test:db      # database suites only
bun run test:api     # admin API suites only
bun run test:k8s     # kubernetes suite only
bun run test:misc    # health/metrics/logs only
```

Arguments after `./run.sh` are passed to `bun test`, so
`./run.sh ssh/auth-password.test.ts` runs a single file.

`tests/misc/encryption-lifecycle.test.ts` also checks upgrade compatibility when
`GATED_PREVIOUS_BINARY` is set next to `GATED_BINARY`: it creates encrypted data
with the old binary, unlocks it with the new one and restores an offline
snapshot. Run it without a controlling terminal
(`setsid --wait bun test misc/encryption-lifecycle.test.ts`) and with isolated
test data.

### Web unit tests

```sh
cd web && bun run test      # vitest run
# or from the repo root:
just test-web
```

### Dockerized full-stack e2e

```sh
docker build -f tests/e2e-docker/Dockerfile.gated -t gated:e2e-build .   # inferred, see section 2
cd tests/e2e-docker
./run.sh             # compose up --wait, bootstrap, all probes, teardown
```

`run.sh` prints a per-probe PASS/FAIL table and exits non-zero on any
failure; teardown (`docker compose down -v`) runs on exit.

### Browser e2e (Playwright)

Two Playwright scripts under `web/scripts/` drive a real browser against a
**running** gateway (they are not part of `bun test` or CI):

- `e2e-smoke.ts` (`bun run e2e`) — login, admin forms (accounts, target
  groups, targets with role binding, users), connect commands, the web SSH
  terminal, ticket share links and monitor pages.
- `e2e-auth-terminals.ts` — login/session/logout plus SSH, MySQL and
  PostgreSQL web terminals; steps whose upstream env is unset are reported as
  blocked.

Prerequisites: a dev gateway (`just dev`, default
`http://gated.localhost:3355`) with admin login `admin`/`admin`, and Playwright
Chromium (`bunx playwright install chromium && bunx playwright install-deps chromium`).
The SSH terminal step needs a reachable sshd (defaults to `127.0.0.1:2299`,
user `e2etest` / `E2eTestPass1`); a full shell additionally requires that sshd
to trust gated's CA (`TrustedUserCAKeys`) or accept the bound account's
password.

```bash
cd web
E2E_BASE=http://gated.localhost:3355 bun run e2e
```

Overridable env: `E2E_BASE`, `E2E_SSH_HOST/PORT/USER/PASS`, `E2E_SHOT_DIR`
(per-step screenshots, default `/tmp/e2e-shots`).

The Playwright dependency also powers the screenshot scripts
(`web/scripts/screenshots.ts` against a dev server at
`http://localhost:5173/ui` by default, override with `SCREENSHOT_BASE`).

---

## 4. Coverage map and gaps

### Covered

| Area | Layer(s) |
|---|---|
| Admin REST API (users, roles, targets, credentials, tickets, sessions, parameters, known-hosts, own-keys, auth) | `tests/api/` |
| Gateway HTTP API (info, login, RBAC target listing, API tokens) | `tests/http/` |
| SSH proxy — password / OTP / public-key / ticket / in-browser auth, protocol behavior, target selection, client auth config | `tests/ssh/`; bound-account precedence also in `tests/e2e-docker` (`probe-ssh.sh`, `scenarios/ssh-key`) |
| PostgreSQL proxy — password and in-browser auth via native `psql` | `tests/db/`, `tests/e2e-docker/scenarios/postgres` |
| MySQL proxy — native `mysql` client through the proxy | `tests/db/mysql-native.test.ts`, `tests/e2e-docker/probe-mysql.sh` |
| SQL console (web) — MySQL and PostgreSQL | `tests/db/sql-console.test.ts` |
| Kubernetes proxy — token and client-cert target auth, `kubectl` through the proxy, upstream mTLS client cert | `tests/kubernetes/`, `tests/e2e-docker/scenarios/k8s-token`, `scenarios/k8s-client-cert` |
| HTTP target proxying — routing, auth, header hygiene, response cap, upstream TLS, plaintext-listener guard | `tests/http-proxy/`, `tests/e2e-docker/scenarios/http-headers` |
| SSO / OIDC login (mock IdP) | `tests/` suites that start the OIDC mock (e.g. `tests/api/credentials/sso.test.ts`, in-browser auth tests) |
| Health, readiness, JSON logging, Prometheus metrics | `tests/misc/` |
| Recording players, terminal codec/WS protocol, admin UI components (DOM level) | `web/src/**/*.test.ts(x)` |
| API schema backward compatibility (admin + gateway OpenAPI) | CI `schema-compatibility` job (oasdiff), PRs only |

### Gaps (no automated e2e)

- **Browser UI flows** — the Playwright scripts (section 3) run manually
  against a live gateway; they are not part of `bun test` or CI.
- **MySQL in-browser auth** — PostgreSQL has password and in-browser auth
  suites under `tests/db/`; MySQL is covered by the native-client suite only.

---

## 5. Delivery checklist

Ordered gates to run before delivering a change. Steps 1–8 mirror the CI
jobs in `.github/workflows/ci.yml`; run them locally in this order so cheap
gates fail first.

```sh
# 0. One-time per machine: tests/ docker images + deps
cd tests && make all && bun install && cd ..
cd web && bun install --frozen-lockfile && cd ..

# 1. Format
just fmt

# 2. Rust lints (workspace lint policy in Cargo.toml)
just clippy

# 3. Frontend static gates
just typecheck
just lint
just i18n-check

# 4. Frontend unit tests
just test-web

# 5. Frontend build (required before any backend binary that ships the UI)
just bun run build

# 6. Rust workspace tests
just test

# 7. Integration suites against a release binary
cargo build --all-features --release
cd tests && GATED_BINARY=target/x86_64-unknown-linux-musl/release/gated bun test --timeout 300000 && cd ..

# 8. Full-stack dockerized e2e
docker build -f tests/e2e-docker/Dockerfile.gated -t gated:e2e-build .   # inferred, see section 2
cd tests/e2e-docker && ./run.sh && cd ../..

# 9. Supply chain / dead deps (CI "quality" job)
cargo machete --with-metadata crates
cargo deny check advisories bans sources licenses
```

Notes:

- `cargo test` (step 6) needs `web/dist` to exist; step 5 guarantees that
  with real assets. CI's empty-dir shortcut is only acceptable when the
  change cannot affect the embedded UI.
- Schema compatibility (oasdiff) runs automatically on pull requests; to
  check locally, regenerate schemas with `just openapi-all` on both branches
  and compare (the exact local invocation is CI-specific — see the
  `schema-compatibility` job).
- Browser-level verification uses the manual Playwright scripts (section 3).
