# E2E 测试交付指南

[English](e2e-delivery.md) | 简体中文

如何运行 gated 项目的每一层测试、每层需要什么、覆盖什么，以及交付变更前要跑的检查清单。

---

## 1. 测试清单

| 层 | 位置 | 运行器 | 覆盖内容 |
|---|---|---|---|
| Rust 单元测试 | `crates/*/src` 中内联的 `#[cfg(test)]` 模块（没有 crate 单独设 `tests/` 目录） | `cargo nextest` / `cargo test` | 各 crate 的纯 Rust 逻辑 |
| 集成测试套件 | `tests/`（Bun + TypeScript，驱动真实的 `gated` 二进制） | `bun test` | 管理 API、网关 HTTP API、SSH / MySQL / PostgreSQL / HTTP / Kubernetes 代理、命令管控、SFTP、SQL 控制台、健康检查 / 指标 / 日志、数据目录和加密生命周期 |
| Web 单元测试 | `web/src/**/*.test.ts(x)` | Vitest（jsdom） | React 组件、hook、API 客户端模块、录制播放器、终端编解码 |
| Docker 全栈 e2e | `tests/e2e-docker/` | `tests/e2e-docker/run.sh` | 类生产容器：通过管理令牌引导，然后从 sidecar 容器发起协议探测（SSH、MySQL、PostgreSQL、HTTP 请求头、Kubernetes 令牌 + 客户端证书） |
| 浏览器（Playwright）e2e | `web/scripts/e2e-smoke.ts`、`web/scripts/e2e-auth-terminals.ts` | `bun run e2e`（冒烟）/ `bun scripts/e2e-auth-terminals.ts` | 真实浏览器访问运行中的网关：登录 / 会话、管理表单、Web 终端、票据链接 |

### 1.1 集成测试套件（`tests/`）详情

每个子目录是一个套件；`tests/package.json` 定义了各套件的脚本。

- `tests/api/` —— 管理 REST API（`/admin/api`，使用 `X-Gated-Token` 头认证；见 `tests/helpers/api-client.ts`）。
  子目录：`accounts/`、`auth/`（cookie 认证、未授权）、`credentials/`（密码、OTP、公钥、证书、SSO）、
  `parameters/`、`roles/`、`sessions/`、`ssh/`（known-hosts、own-keys）、`system/`、`target-groups/`、`targets/`、
  `tickets/`、`users/`；顶层文件覆盖 RBAC 矩阵、认证契约、命令记录和录制。
- `tests/http/` —— 网关 HTTP API：`/api/info`、`/api/auth/login` 及其限速、OIDC 安全、`/api/targets` 的 RBAC 过滤、
  API 令牌、票据范围、WebSocket origin 检查。
- `tests/http-proxy/` —— HTTP 反向代理：访问控制、明文监听保护、上游 TLS。
- `tests/ssh/` —— 针对容器化 sshd 的 SSH 代理端到端测试：密码、OTP、公钥、票据和浏览器内认证；登录失败审计、会话
  列表过滤、账户绑定、命令 ACL 与审批、SFTP、RBAC、Web 终端撤销、协议行为（`proto.test.ts`）、目标选择、客户端认证
  配置。
- `tests/db/` —— 用真实 `psql` 客户端驱动的 PostgreSQL 代理认证（密码、浏览器内）、通过代理的原生 MySQL 客户端、
  命令 ACL 过滤、多协议票据、RBAC，以及 MySQL 和 PostgreSQL 的 Web SQL 控制台。
- `tests/kubernetes/` —— 针对 `rancher/k3s` 容器的 Kubernetes 代理，使用令牌和客户端证书目标认证，通过 `kubectl` 执行。
- `tests/misc/` —— `/healthz` + `/readyz`、JSON 日志输出、日志注入、Prometheus `/metrics`、`--data-dir` 和加密生命周期。
- `tests/helpers/` —— 共享基础设施，不是测试：`process-manager.ts` 在每个测试中用随机端口先运行
  `gated unattended-setup` 再运行 `gated run --enable-admin-token`，并启动 sshd、MySQL、PostgreSQL、k3s 和 OIDC mock
  （`ghcr.io/soluto/oidc-server-mock:0.10.1`）的 docker 容器；`setup.ts` 由 `tests/bunfig.toml` 预加载（修正 SSH
  密钥权限、关闭 TLS 验证）。
- 测试夹具：`tests/certs/`（复制到每个测试数据目录的 TLS 证书 / 密钥）、`tests/ssh-keys/`（客户端 / 主机密钥；`wg/`
  子目录存放网关自己的密钥）、`tests/images/`（本地 `gated-e2e-ssh-server`、`gated-e2e-mysql-server`、
  `gated-e2e-postgres-server` 镜像的 Dockerfile，由 `tests/Makefile` 构建）、`tests/oidc-mock/`（端口 4011 上 OIDC
  mock 的独立 docker-compose 版本；测试辅助代码会自己启动容器，因此这个 compose 文件供手动使用）。

### 1.2 Docker 全栈 e2e（`tests/e2e-docker/`）详情

`docker-compose.yml` 构建 `Dockerfile.bootstrapped`（预先引导好的 `gated` 镜像，开启管理令牌和录制，内部端口固定为
8888/2222/33306/35432/36443），外加 `ssh-upstream` 和 `mysql-upstream` 服务。`run.sh` 启动整套服务，通过
`curlimages/curl` sidecar 运行 `bootstrap.sh`，然后自动发现并运行探测：

- 顶层的 `probe-ssh.sh`、`probe-mysql.sh` —— 通过代理使用原生 `ssh`/`mysql` 客户端，断言绑定账户凭据优先于故意写错
  的内联凭据；
- `scenarios/<name>/{compose.yml,bootstrap.sh,probe.sh}` —— `ssh-key`、`postgres`、`http-headers`、`k8s-token`、
  `k8s-client-cert`（向上游出示 mTLS 客户端证书；见 `scenarios/k8s-client-cert/README.md`）。

所有探测都在接入 compose 网络（`e2e-docker_e2e`）的 sidecar 容器中运行，因为主机端口映射可能被防火墙拦截。

---

## 2. 各层前置条件

### 工具链

- **Rust** —— 由 `rust-toolchain.toml` 固定：channel 1.95.0，含 clippy 和 rustfmt。`just` 配方默认把
  `CARGO_BUILD_TARGET` 设为 `x86_64-unknown-linux-gnu`（见 `justfile`）。
- **Bun** —— 用于 `web/` 和 `tests/`（CI 在 workflow 中固定版本）。
- **Docker** —— `tests/`（容器化的 sshd/MySQL/PostgreSQL/k3s/OIDC mock）和 `tests/e2e-docker/`（compose + sidecar）
  都需要。
- **just** —— 仓库根目录 `justfile` 的命令运行器。

### Rust 单元测试

- `crates/gated-web/src/lib.rs` 通过 `rust-embed` 嵌入 `web/dist`，因此在任何工作区构建之前该目录必须存在。CI 在
  测试 / lint 任务中使用 `mkdir -p web/dist`（`.github/workflows/ci.yml`）；真正交付的二进制需要实际的 Web 构建
  （第 3 节）。
- CI 还会在 Ubuntu 上安装 `libssl-dev pkg-config`。

### 集成测试套件（`tests/`）

- 一个 `gated` 二进制。未设置 `GATED_BINARY` 时，`tests/run.sh` 会自动构建
  `target/x86_64-unknown-linux-musl/debug/gated`；设置 `GATED_BINARY=<path>` 可使用其他构建（CI 指向 release 二进制）。
- 本地 docker 镜像：`cd tests && make all` 从 `tests/images/` 构建 `gated-e2e-ssh-server`、`gated-e2e-mysql-server`、
  `gated-e2e-postgres-server`（`tests/Makefile`）。
- 拉取的镜像（首次使用时获取）：`rancher/k3s:v1.35.2-k3s1`（可用 `K3S_IMAGE` 覆盖）、
  `ghcr.io/soluto/oidc-server-mock:0.10.1`（`tests/helpers/process-manager.ts`）。
- 测试本身使用的主机二进制：`psql` 和 `mysql`（`tests/db/`）、`sshpass` 和 `expect`（`tests/ssh/`）、`kubectl`
  （`tests/kubernetes/`）、`ssh`。测试使用 MariaDB 客户端的选项，因此 CI 集成任务会安装 `mariadb-client`（替换
  runner 自带的 MySQL 客户端），以及 `openssh-client sshpass expect gnome-keyring kubectl postgresql-client`。
- Docker 网络：套件在 `traefik` 网络上启动上游容器，并通过容器 IP 访问；CI 用 `docker network create traefik` 创建。
- Node 依赖：在 `tests/` 中执行 `bun install`（`node_modules` 缺失时 run.sh 会自动执行）。
- 端口：辅助代码为每个测试随机分配 —— 没有需要释放的固定端口。
- 环境变量：`GATED_BINARY`（二进制路径）、`TIMEOUT`（辅助代码等待超时秒数，默认 10；CI 使用 120）、
  `RUST_BACKTRACE=1` 和 `NODE_TLS_REJECT_UNAUTHORIZED=0`（都由 `tests/run.sh` 导出；后者也由预加载的
  `tests/helpers/setup.ts` 设置）。
- SSH 密钥夹具必须是 `chmod 600`（`run.sh` 和 `setup.ts` 会处理）。

### Web 单元测试

- `cd web && bun install --frozen-lockfile`（或 `bun install`）。
- 不需要服务；Vitest 在 jsdom 中运行（`web/vitest.config.ts`、`web/vitest.setup.ts`）。

### Docker 全栈 e2e

- 带 compose 插件的 Docker（`docker compose`）。
- 在 `docker compose` 构建 `Dockerfile.bootstrapped` 之前，基础镜像 `gated:e2e-build` 必须已存在（其第一行是
  `FROM gated:e2e-build`）。仓库中没有文件记录它的构建命令；以下由 `tests/e2e-docker/Dockerfile.gated`
  **推断**（其构建上下文必须是仓库根目录，因为它执行 `COPY . /opt/gated`）：

  ```sh
  # inferred, not recorded in the repo:
  docker build -f tests/e2e-docker/Dockerfile.gated -t gated:e2e-build .
  ```

- compose 文件映射了主机端口 18888/12222/13306/15432/16443，但不要求它们可达 —— 探测在 compose 网络内的 sidecar 中
  运行。

---

## 3. 如何运行

### 构建顺序

后端嵌入前端：`crates/gated-web` 在编译时引入 `web/dist`。因此，凡是 UI 有意义的二进制（涉及 Web 控制台的集成测试、
e2e-docker、发布）：

```sh
cd web && bun install --frozen-lockfile && bun run build   # 1. web first
cargo build                                                # 2. then backend
```

只跑单元测试 / lint 时，空的 `mkdir -p web/dist` 即可（CI 的 `test` 和 `quality` 任务就是这样做的）。

### Rust 单元测试

```sh
just test            # cargo test --target <target> --workspace --all-features
# or, as CI runs it:
cargo nextest run --profile ci --workspace --all-features --locked
cargo test --doc --workspace --all-features --locked
```

### 集成测试套件（`tests/`）

最简单的方式（自动构建 debug 二进制、安装依赖、修正密钥权限）：

```sh
cd tests
make all             # one-time: build the three local docker images
./run.sh             # builds a debug gated if GATED_BINARY is unset, then `bun test`
```

手动 / 选择性运行：

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

`./run.sh` 之后的参数会传给 `bun test`，因此 `./run.sh ssh/auth-password.test.ts` 只运行单个文件。

当 `GATED_BINARY` 旁边还设置了 `GATED_PREVIOUS_BINARY` 时，`tests/misc/encryption-lifecycle.test.ts` 也会检查升级
兼容性：用旧二进制创建加密数据，用新二进制解锁，并恢复一份离线快照。请在没有控制终端的情况下运行
（`setsid --wait bun test misc/encryption-lifecycle.test.ts`），并使用隔离的测试数据。

### Web 单元测试

```sh
cd web && bun run test      # vitest run
# or from the repo root:
just test-web
```

### Docker 全栈 e2e

```sh
docker build -f tests/e2e-docker/Dockerfile.gated -t gated:e2e-build .   # inferred, see section 2
cd tests/e2e-docker
./run.sh             # compose up --wait, bootstrap, all probes, teardown
```

`run.sh` 打印每个探测的 PASS/FAIL 表，任一失败即以非零退出；退出时执行清理（`docker compose down -v`）。

### 浏览器 e2e（Playwright）

`web/scripts/` 下的两个 Playwright 脚本驱动真实浏览器访问**运行中**的网关（它们不属于 `bun test` 或 CI）：

- `e2e-smoke.ts`（`bun run e2e`）—— 登录、管理表单（账户、目标分组、带角色绑定的目标、用户）、连接命令、Web SSH 终端、
  票据分享链接和监控页面。
- `e2e-auth-terminals.ts` —— 登录 / 会话 / 登出，以及 SSH、MySQL 和 PostgreSQL Web 终端；上游环境变量未设置的步骤会
  报告为 blocked。

前置条件：一个开发网关（`just dev`，默认 `http://gated.localhost:3355`），管理员登录为 `admin`/`admin`，以及
Playwright Chromium（`bunx playwright install chromium && bunx playwright install-deps chromium`）。SSH 终端步骤需要可达
的 sshd（默认 `127.0.0.1:2299`，用户 `e2etest` / `E2eTestPass1`）；要获得完整 shell，该 sshd 还需要信任 gated 的 CA
（`TrustedUserCAKeys`）或接受绑定账户的密码。

```bash
cd web
E2E_BASE=http://gated.localhost:3355 bun run e2e
```

可覆盖的环境变量：`E2E_BASE`、`E2E_SSH_HOST/PORT/USER/PASS`、`E2E_SHOT_DIR`（每步截图，默认 `/tmp/e2e-shots`）。

Playwright 依赖也用于截图脚本（`web/scripts/screenshots.ts`，默认访问 `http://localhost:5173/ui` 的开发服务器，可用
`SCREENSHOT_BASE` 覆盖）。

---

## 4. 覆盖情况与缺口

### 已覆盖

| 领域 | 测试层 |
|---|---|
| 管理 REST API（用户、角色、目标、凭据、票据、会话、参数、known-hosts、own-keys、认证） | `tests/api/` |
| 网关 HTTP API（info、登录、按 RBAC 列出目标、API 令牌） | `tests/http/` |
| SSH 代理 —— 密码 / OTP / 公钥 / 票据 / 浏览器内认证、协议行为、目标选择、客户端认证配置 | `tests/ssh/`；绑定账户优先级也在 `tests/e2e-docker` 中（`probe-ssh.sh`、`scenarios/ssh-key`） |
| PostgreSQL 代理 —— 通过原生 `psql` 的密码和浏览器内认证 | `tests/db/`、`tests/e2e-docker/scenarios/postgres` |
| MySQL 代理 —— 通过代理的原生 `mysql` 客户端 | `tests/db/mysql-native.test.ts`、`tests/e2e-docker/probe-mysql.sh` |
| SQL 控制台（Web）—— MySQL 和 PostgreSQL | `tests/db/sql-console.test.ts` |
| Kubernetes 代理 —— 令牌和客户端证书目标认证、通过代理的 `kubectl`、上游 mTLS 客户端证书 | `tests/kubernetes/`、`tests/e2e-docker/scenarios/k8s-token`、`scenarios/k8s-client-cert` |
| HTTP 目标代理 —— 路由、认证、请求头清理、响应上限、上游 TLS、明文监听保护 | `tests/http-proxy/`、`tests/e2e-docker/scenarios/http-headers` |
| SSO / OIDC 登录（mock IdP） | 启动 OIDC mock 的 `tests/` 套件（例如 `tests/api/credentials/sso.test.ts`、浏览器内认证测试） |
| 健康检查、就绪检查、JSON 日志、Prometheus 指标 | `tests/misc/` |
| 录制播放器、终端编解码 / WS 协议、管理 UI 组件（DOM 层面） | `web/src/**/*.test.ts(x)` |
| API 结构向后兼容（管理 + 网关 OpenAPI） | CI `schema-compatibility` 任务（oasdiff），仅 PR |

### 缺口（无自动化 e2e）

- **浏览器 UI 流程** —— Playwright 脚本（第 3 节）需手动针对运行中的网关执行；它们不属于 `bun test` 或 CI。
- **MySQL 浏览器内认证** —— PostgreSQL 在 `tests/db/` 下有密码和浏览器内认证套件；MySQL 只有原生客户端套件覆盖。

---

## 5. 交付检查清单

交付变更前按顺序执行的检查。第 1–8 步与 `.github/workflows/ci.yml` 中的 CI 任务对应；按此顺序在本地运行，让开销小的
检查先失败。

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

说明：

- `cargo test`（第 6 步）需要 `web/dist` 存在；第 5 步用真实资源保证了这一点。CI 的空目录捷径只适用于不可能影响内嵌
  UI 的变更。
- 结构兼容性检查（oasdiff）在 pull request 上自动运行；如需本地检查，在两个分支上分别用 `just openapi-all` 重新生成
  结构并比较（确切的本地调用方式依赖 CI —— 见 `schema-compatibility` 任务）。
- 浏览器层面的验证使用手动的 Playwright 脚本（第 3 节）。
