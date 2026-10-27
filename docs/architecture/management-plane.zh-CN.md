# 管理面

[English](management-plane.md) | 简体中文

管理面是 `gated-admin` 提供的常驻 HTTP 服务（`HTTPProtocolServer`，一个 `ProtocolServer` 实现），在同一个
监听器上承载三个面：管理 API、用户门户 API 和内嵌 SPA。CLI（`crates/gated`）和 YAML 配置结构
（`crates/gated-common`）共同构成管理面。

## HTTP 服务组成（`crates/gated-admin`）

路由布局（`crates/gated-admin/src/http_service/mod.rs`）：

- `/admin/api` —— 管理 REST API（axum + utoipa），包裹在 `require_auth` 和 `require_admin` 中间件中，因此
  既需要已认证的会话 / 令牌，*又*需要内置的 `admin` 角色（`mod.rs`）；OpenAPI 规范位于
  `/admin/api/openapi.json`，附带 Stoplight Elements playground。
- `/api` —— 用户门户 API（axum + utoipa），任何已认证会话可用；规范位于 `/api/openapi.json`（`mod.rs`）。
- `/api/ssh/terminal/:target_name`、`/api/mysql/terminal/:target_name`、
  `/api/postgres/terminal/:target_name` —— 浏览器内终端的原始 WebSocket 端点，以及用于流式文件传输的
  `/api/sftp/:target_name/download` / `upload`（无法用 OpenAPI 表达，直接挂载）。
- `/ui` —— 内嵌 SPA（见下文）；未认证的页面加载会重定向到登录路由。

中间件栈（`mod.rs`），越靠后越外层：

1. `TicketMiddleware` —— 把 `gated-ticket` 查询参数转换为受限会话（`middleware/ticket.rs`）。
2. `DbLockMiddleware` —— 加密数据库锁定时，只有加密解锁端点响应；其余一律返回 503。
3. `SessionLayer` —— cookie 会话（cookie `gated-http-session`，TLS 开启时带 secure 标志，max-age 可配置）；
   服务端状态保存在内存中并定期清理。登录会在内存管理会话注册表中创建 `ManagementSessionHandle`
   （`http_service/session.rs`），而不是代理会话：浏览器登录没有 `sessions` 行，也不出现在会话列表中。它们在
   登出、空闲过期（`admin.session_max_age`）、重启、管理员撤销（`/admin/api/management-sessions`）或修改密码
   （会撤销该用户的其他浏览器会话和实时代理会话）时结束。
4. `CookieHostMiddleware` —— 把 cookie 绑定到预期主机，防止跨子域复用。

安全响应头（`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`，TLS 时加 HSTS）
全局设置。请求也可以用 `X-Gated-Token` 头（管理令牌或 API 令牌）代替 cookie 认证（`http_service/common.rs`）。

### 管理审计

`audit_request`（`http_service/management_audit.rs`）把可识别操作者（管理令牌记录为 `admin-token`）在
`/admin/api/`、`/api/profile/` 和 `/api/auth/` 下发起的每个 `POST`/`PUT`/`PATCH`/`DELETE`（`/admin/api/logs`
和 `/admin/api/management-audit` 查询除外）记录到 `management_audit` 表：处理器运行前写一条 `requested`，
之后写一条带响应状态的 `completed`。如果 `requested` 行写不进去，操作会被拒绝。未认证的请求（例如登录尝试）
不在这里记录。通过 `POST /admin/api/management-audit` 查询。

### 管理 API 模块（`crates/gated-admin/src/api/`）

提供以下资源的 CRUD 和操作：用户（含每用户各类凭据和凭据要求策略）、角色、目标和目标分组、目标 / 角色
绑定、会话（列表、详情、关闭、强制终止、删除）、录制（获取、asciicast 导出、PCAP 导出、实时流）、票据、
日志条目、全局参数、SSH 主机密钥、known hosts、API 令牌、账户（目标绑定账户）、证书签发 / 吊销、浏览器
登录会话、管理审计、文件记录、命令管控（ACL 规则、审批、命令记录），以及通过 lode 更新 / 重启。

### 用户门户 API 模块（`crates/gated-admin/src/http_service/api/`）

`auth`（登录 / 登出 / OTP / SSO / 认证状态批准）、`info`、`targets_list`（仅用户有权访问的目标）、
`credentials`（自助管理密码 / 密钥 / OTP / 证书）、`api_tokens`、`tickets`、`sessions`（自己的会话）、
`db_query` + `sql_validation`（SQL 控制台）、`ssh_terminal` / `db_terminal`（Web 终端）、`sftp`（Web 文件
管理器）、`sso_provider_list` / `sso_provider_detail`，以及 `encryption`（解锁前引导）。

### 登录流程

`POST /api/auth/login` 开始一个认证状态；响应中的状态告诉 SPA 下一步收集什么：`OtpNeeded`、`SsoNeeded`、
`WebUserApprovalNeeded` 或 `Success`（`http_service/api/auth.rs`）。SSO 发起 / 回调端点驱动
[auth.zh-CN.md](auth.zh-CN.md) 中描述的 OIDC 交换。用户策略要求网页批准时，也是在同一个门户会话中批准待处理的
SSH / 数据库登录。

## 内嵌 Web UI（`crates/gated-web` + `web/`）

`gated-web` 用 `rust-embed` 嵌入构建好的 SPA（`crates/gated-web/src/lib.rs`，目录 `web/dist`）。管理服务在
`/ui` 下提供它，带 `index.html` SPA 回退（`http_service/spa.rs`），对带哈希的资源使用 immutable 缓存，对
`index.html` 使用 `no-cache`。

SPA（`web/`）基于 React 19 + TanStack Router + Tailwind 4，用 Vite（base 路径 `/ui/`）和 Bun 构建。API 类型由
`web/scripts/generate-openapi-types.ts` 从 Rust 源码导出的 OpenAPI 规范生成；已提交的快照和类型在 CI 中校验。
功能区：

- **用户门户**：登录、带连接信息的目标列表、Web SSH 和数据库终端（xterm.js）、SQL 控制台、文件管理器、自助
  凭据管理（密码、SSH 密钥、带二维码的 TOTP 绑定、客户端证书）、API 令牌、票据、自己的会话。
- **管理区**：用户 / 角色 / 目标分组 / 账户管理、目标配置（含 HTTP 变体标记）、带关闭操作的实时会话监控、
  录制回放（终端录制用 asciinema 播放器、HTTP 交互查看器、PCAP 下载）、审计日志浏览、命令管控、文件记录、
  全局参数、known hosts、更新与重启。

## CLI（`crates/gated`）

子命令（`crates/gated/src/main.rs`）：

| 命令 | 用途 |
|---|---|
| `setup` / `unattended-setup` | 首次运行引导：写出 YAML 配置，创建数据目录、数据库、管理员用户、自签名 TLS 证书、SSH 密钥 |
| `run` | 启动所有启用的监听器；`--enable-admin-token`、`--admin-port`（开发时接受字面量 `NSL_PORT`） |
| `check` | 校验配置文件 |
| `create-user` | 创建用户，可选密码 / 角色 |
| `recover-access` | 重置用户的密码和凭据策略 |
| `client-keys` | 打印 gated 连接目标时使用的 SSH 公钥 |
| `healthcheck` | 存活探针；`--deep` 增加数据库 ping、迁移状态、TLS 和 SSO 检查 |
| `encrypt-existing-db` | 把明文 SQLite 数据库迁移到 SQLCipher |
| `version` | 打印版本 |

`run` 的组装见 [README.zh-CN.md](README.zh-CN.md#部署模型)；会话、保留期清理、配置监视和 systemd 通知在
`crates/gated/src/commands/run.rs` 中。

## 配置结构（`crates/gated-common/src/config/`）

`GatedConfigStore`（`crates/gated-common/src/config/mod.rs`）是 YAML 根：

| 段 | 要点 |
|---|---|
| `sso_providers` | OIDC 提供者列表（见 [auth.zh-CN.md](auth.zh-CN.md)） |
| `recordings` | `enable`、`path`（默认 `./data/recordings`） |
| `external_host` | 用于 URL / SSO 重定向的公开主机名 |
| `database_url` | 密钥；默认 `sqlite:data/db` |
| `ssh` | enable、listen、密钥路径、主机密钥验证模式、空闲超时、keepalive |
| `admin` | 管理 / 门户监听器：listen、TLS 证书 / 密钥（或 `tls: false`）、SNI 证书、cookie 域、会话 / cookie max-age、`trust_x_forwarded_headers` |
| `http` | 反向代理监听器：enable、listen、TLS 证书 / 密钥、用于按主机路由的 `base_domain`、`behind_proxy`、会话 max-age |
| `mysql` / `postgres` | enable、listen、TLS 证书 / 密钥 |
| `metrics` | 为 `/metrics`、`/healthz`、`/readyz` 设置 enable + listen |
| `encryption` | 开启数据库静态加密 |
| `log` | 保留期和管理审计保留期（默认各 7 天）、级别、格式、控制台 / 文件输出、可选的 syslog socket 和 OTLP 导出器 |

加载：使用 `--data-dir`/`GATED_DATA_DIR` 时 YAML 文件为 `<dir>/config.yaml`，否则为 `-c`/`GATED_CONFIG`
（默认 `/etc/gated.yaml`）。它会与 `GATED_*` 环境变量覆盖合并；相对路径以数据目录解析，没有数据目录时以配置
文件所在目录解析；密钥包装在 `Secret` 类型中，调试输出会被遮蔽。仓库根目录的 `config-schema.json` 通过
`schemars` 从这些类型生成，并在 CI 中检查是否漂移。

目标**不在** YAML 中：它们保存在数据库里，通过管理 API / UI 管理。目标行包含 `allow_roles`、可选分组、可选的
字节速率限制、绑定账户，以及 `TargetOptions` 联合类型（`ssh` / `http` / `mysql` / `postgres`，
`crates/gated-common/src/config/target.rs`）。
