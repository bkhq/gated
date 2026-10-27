# 认证与授权

[English](auth.md) | 简体中文

所有协议都汇入同一套凭据模型、同一个认证状态机和同一个授权检查，分别实现在 `gated-common`（类型）、
`gated-core`（状态存储 + 基于数据库的配置提供者）和 `gated-sso`（OIDC）中。

## 凭据类型

`CredentialKind`（`crates/gated-common/src/auth/cred.rs`）枚举：
`Password`、`PublicKey`、`Certificate`、`Totp`、`Sso`、`WebUserApproval`。
`AuthCredential`（`cred.rs`）是认证过程中提交的运行时值（OTP 验证码、密码、提供的公钥、证书 PEM、
SSO 提供者 + 邮箱，或网页批准标记）。

存储（每种类型一个 SeaORM 实体，都在 `crates/gated-db-entities/src/`）：

| 类型 | 实体 | 存储形式 |
|---|---|---|
| 密码 | `PasswordCredential` | Argon2 哈希 |
| 公钥 | `PublicKeyCredential` | OpenSSH 公钥 + `last_used` |
| 证书 | `CertificateCredential` | 签发的证书 PEM（见 [tls-and-ca.zh-CN.md](tls-and-ca.zh-CN.md)） |
| TOTP | `OtpCredential` | 密钥字节 |
| SSO | `SsoCredential` | 提供者名称 + 邮箱 |
| 网页批准 | 无 | 通过 Web 会话实时授予 |

## 认证状态机

`AuthState`（`crates/gated-common/src/auth/state.rs`）为一次登录尝试累积已验证的凭据，并询问其
`CredentialPolicy` 是否足够。`verify()`（`state.rs`）返回 `AuthResult`（`state.rs`）：`Accepted`、
`Need(类型集合)` 或 `Rejected`。

策略（`crates/gated-common/src/auth/policy.rs`）：

- `AnySingleCredentialPolicy`（`policy.rs`）—— 任意一个有效凭据即可（默认）；
- `AllCredentialsPolicy`（`policy.rs`）—— 需要列出的所有类型；
- `PerProtocolCredentialPolicy`（`policy.rs`）—— 按协议（HTTP / SSH / MySQL / PostgreSQL）区分要求，并带
  默认回退。

每个用户的有效策略由 `ConfigProvider::get_credential_policy`
（`crates/gated-core/src/config_providers/db.rs`）构建：收集用户实际拥有的凭据类型（总是加上
`WebUserApproval`），再把用户存储的 `UserRequireCredentialsPolicy`（如有）作为按协议的
`AllCredentialsPolicy` 要求叠加上去。

进行中的状态保存在 `AuthStateStore`（`crates/gated-core/src/auth_state_store.rs`）中，以 UUID 为键，
通过 `create()`（`auth_state_store.rs`）创建，定期清理，并可通过广播通道观察。

### 网页批准非 Web 登录

当策略要求 `WebUserApproval` 时，协议会话（SSH keyboard-interactive、PostgreSQL）会给出一个包含认证状态
id 的浏览器 URL。已登录门户的用户能看到待处理的尝试（`all_pending_web_auths_for_user`，
`auth_state_store.rs`），批准其中一个后，`AuthCredential::WebUserApproval` 会追加到该状态
（`crates/gated-admin/src/http_service/api/auth.rs`）；等待中的协议会话通过存储的广播通道收到通知并重新验证。

## SSO / OIDC（`crates/gated-sso`）

提供者在 `sso_providers` 下配置为 `SsoInternalProviderConfig`（`crates/gated-sso/src/config.rs`）：
`Google`、`Apple`（key id + team id）、`Azure`（tenant）或 `Custom`（issuer URL、scopes、可选的角色映射、
audience 选项）。

登录流程：

1. `SsoClient::start_login` 执行 OIDC 发现，构建带 PKCE（Apple 除外）、CSRF 令牌和 nonce 的授权码请求
   （`crates/gated-sso/src/sso.rs`）。
2. HTTP 门户把浏览器重定向到 IdP；回调返回 gated 后，`SsoLoginRequest::verify_code` 兑换授权码、校验
   ID token 声明，可选地获取 userinfo，并提取 `preferred_username`、`email`、`name`、`email_verified`
   （`crates/gated-sso/src/request.rs`）。
3. 自定义的 `gated_roles` 声明（字符串或数组，`crates/gated-sso/src/sso.rs`，在 `request.rs` 中读取）携带
   来自 IdP 的组 / 角色名。

角色映射：回调处理器通过提供者的 `role_mappings` 转换远端名称，并调用
`ConfigProvider::apply_sso_role_mappings`（`crates/gated-core/src/config_providers/db.rs`），增删
`UserRoleAssignment` 行，使受管角色在每次登录时与 IdP 保持一致。当提供者元数据暴露
`end_session_endpoint` 时支持单点登出。

## RBAC

授权模型由三个实体构成（`crates/gated-db-entities/src/`）：`Role`、`UserRoleAssignment`、
`TargetRoleAssignment`。`ConfigProvider::authorize_target`（`crates/gated-core/src/config_providers/db.rs`）
加载用户和目标的角色集合，交集非空时授予访问。每个协议在认证之后、连接目标之前调用它。

内置的 `admin` 角色（`BUILTIN_ADMIN_ROLE_NAME`，`crates/gated-core/src/consts.rs`）在数据库引导时创建，
用于把守管理 API：`require_admin`（`crates/gated-admin/src/http_service/common.rs`）检查会话用户是否拥有它。

## 票据

票据是绑定到（用户，目标）对的、预先授权的单用途密钥 —— 适合在不共享真实凭据的情况下发放受限访问。实体
（`crates/gated-db-entities/src/Ticket.rs`）：`secret`（以哈希存储）、`username`、`target`、可选的
`uses_left` 计数（null = 不限）以及可选的 `expiry`。

- 创建（管理 API）时验证指定用户对该目标有权限，生成 32 字节随机数并十六进制编码
  （`crates/gated-common/src/helpers/hash.rs`），密钥只返回一次。
- 使用：`authorize_ticket`（`crates/gated-core/src/config_providers/mod.rs`）对提交的密钥求哈希、匹配摘要，
  并检查过期时间 / 使用次数；`consume_ticket` 原子地递减有限的 `uses_left`。
- 协议入口：SSH/MySQL/PostgreSQL 使用 `ticket-<secret>` 形式的用户名；Web 门户接受 `gated-ticket` 查询参数，
  由 `ticket_middleware`（`crates/gated-admin/src/http_service/middleware/ticket.rs`）处理，建立仅限票据目标
  的会话。HTTP 反向代理监听器不接受票据。

## API 令牌与 Web 会话

- **API 令牌**（`crates/gated-db-entities/src/ApiToken.rs`）：每用户、带标签和过期时间的密钥，以哈希存储，由
  `ConfigProvider::validate_api_token`（`crates/gated-core/src/config_providers/db.rs`）校验。在 HTTP 反向
  代理上以 `Authorization: Bearer` 接受，在门户 / 管理 API 上以 `X-Gated-Token` 接受。
- **管理令牌**：`gated run --enable-admin-token` 把 `GATED_ADMIN_TOKEN` 环境变量的值映射到第一个管理员
  用户 —— 用于自动化和 e2e 测试框架。
- **Web 会话**：cookie `gated-http-session`（`crates/gated-admin/src/http_service/common.rs`），服务端存储
  会话，cookie max-age（默认 24 小时）和会话 max-age（默认 30 分钟）分开设置，并按主机校验 cookie。

## 认证失败的行为

没有账户锁定。SSH 监听器在失败后应用 russh 的 1 秒延迟；认证结果计入 `gated_auth_attempts_total` 指标
（标签 `result`、`method`，`crates/gated-core/src/metrics.rs`）。每用户和每目标的
`rate_limit_bytes_per_second` 设置限制的是数据传输，而不是认证尝试。
