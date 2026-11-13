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

用户的角色分配可以带 `expires_at`（`user_roles.expires_at`，在用户对话框或通过
`PUT /admin/api/users/:id/roles/:role_id` 设置）。已过期的分配不授予任何权限：读取用户角色一律经过
`User::Model::active_roles` 或 `UserRoleAssignment::unexpired` 条件（目标访问、文件传输、账号解析、
按角色生效的命令规则、管理员检查）。记录本身保留，管理员可以看到它已过期，并延期或删除。`watch_role_expiry`
（`crates/gated/src/commands/run.rs`）每 15 秒查找新过期的分配并触发 `Services::revalidate_sessions`，
关闭由该分配准入的会话。SSO 角色映射添加的角色不带到期时间。

内置的 `admin` 角色（`BUILTIN_ADMIN_ROLE_NAME`，`crates/gated-core/src/consts.rs`）在数据库引导时创建，
用于把守管理 API：`require_admin`（`crates/gated-admin/src/http_service/common.rs`）检查会话用户是否拥有它。

## 票据

票据是绑定到（用户，目标）对的、预先授权的单用途密钥 —— 适合在不共享真实凭据的情况下发放受限访问。实体
（`crates/gated-db-entities/src/Ticket.rs`）：`secret`（以哈希存储）、`username`、`target`、可选的
`uses_left` 计数（null = 不限）以及可选的 `expiry`。

- 票据把用户的访问收窄到单个目标，从不替代用户自身的授权：创建时要求用户已有该授权，每次使用都会重新检查，
  用户失去授权时 `Services::revalidate_sessions` 会关闭票据会话。
- 创建（管理 API）时验证用户和目标存在、用户对该目标有权限、`expiry` 在未来且 `number_of_uses` 为正，
  生成 32 字节随机数并十六进制编码
  （`crates/gated-common/src/helpers/hash.rs`），密钥只返回一次。
- 使用：`authorize_ticket`（`crates/gated-core/src/config_providers/mod.rs`）对提交的密钥求哈希、匹配摘要，
  并检查过期时间 / 使用次数；`consume_ticket` 原子地递减有限的 `uses_left`。
- 协议入口：SSH/MySQL/PostgreSQL 使用 `ticket-<secret>` 形式的用户名；Web 门户接受 `gated-ticket` 查询参数，
  由 `ticket_middleware`（`crates/gated-admin/src/http_service/middleware/ticket.rs`）处理，建立仅限票据目标
  的会话。HTTP 反向代理监听器不接受票据。
- 票据会话与浏览器会话一同列出并可在那里吊销；票据被删除或过期时会话随之结束，已打开的 Web 终端会在
  10 秒内关闭。票据会话不能使用 `/api/profile/*`。
- 票据记录的是用户名和目标名。删除用户或目标会删除其票据；重命名会把票据迁移到新名称，并结束以旧名称打开的
  票据会话。

## 登录失败节流

`gated_core::auth_throttle` 在一张有上限的内存表中统计所有监听器（SSH、MySQL、PostgreSQL、Web 登录）的
密码与 OTP 失败次数，窗口为 5 分钟。计数器满后，后续尝试不再校验，直接按凭据错误处理：

| 计数器 | 每窗口上限 |
|---|---|
| 密码，按（用户，客户端地址） | 10 |
| 密码，按客户端地址 | 60 |
| 密码，按用户 | 100 |
| OTP，按用户 | 10 |

公钥、证书与 SSO 不计入。Web 登录另外保留自己的按次限流。计数器按进程保存，重启后清零。

### 登录保护

在上述计数器之后，`gated_core::login_protection` 把密码与 OTP 的失败记录保存在数据库（`failed_login_attempts`），
并据此生成地址封禁（`ip_blocks`）和用户锁定（`user_lockouts`）。它们在重启后仍然有效，管理员可以查看并解除
（设置 > 安全，`/admin/api/login-protection/*`）。阈值保存在 `parameters`（参数 API 中的 `login_protection`），默认开启。

- 同一地址在 `ip_window_seconds`（15 分钟）内失败 `ip_max_attempts` 次（20）即被封禁，不区分用户名。首次封禁
  `ip_block_seconds`（30 分钟）；距上次封禁结束 24 小时内再次被封禁则时长翻倍，直到 `ip_max_block_seconds`（24 小时）。
- 同一用户在 `user_window_seconds`（1 小时）内从任意地址失败 `user_max_attempts` 次（10）即被锁定
  `user_lockout_seconds`（1 小时；`0` 表示直到手动解除）。不存在的用户名不会被锁定。拥有 `admin` 角色的用户不会被锁定，
  否则任何知道用户名的人都能把管理员挡在外面；地址封禁和内存中的按用户限额对其仍然有效。
- 封禁或锁定期间，密码与 OTP 尝试不再校验，直接按凭据错误处理。公钥、证书、SSO、票据与 API 令牌不受影响，也不计数。
  使用不存在的用户名登录会计入地址（SSH 只计密码尝试，不计公钥试探）。
- 登录成功不会清除之前的失败记录；它们在统计周期过后自然失效。
- 客户端地址取 TCP 对端地址。Web 登录在开启 `trust_x_forwarded_headers` 时取 `X-Forwarded-For` 的最后一项，
  即最近一层代理追加的地址；之前的项由客户端自行填写。经过两层及以上代理时，该项是外层代理的地址，所有用户共享
  同一个封禁：这种部署应调高 `ip_max_attempts` 或关闭登录保护。
- 被挡在外面时的恢复途径：管理令牌（不受封禁影响），或 `gated recover-access`（解除所选用户的锁定和全部地址封禁）。
- 审计事件：`login_ip_blocked`、`login_user_locked`、`auth_refused`。

### 用户允许的来源地址

可以把用户限制在若干 IP 地址和 CIDR 网段内（`users.allowed_ip_ranges`，在用户对话框或通过
`PUT /admin/api/users/:id` 编辑）。设置列表后，来自其他地址或无法确定地址的请求都会被拒绝：

| 路径 | 检查位置 | 范围之外的应答 |
|---|---|---|
| SSH、MySQL、PostgreSQL、Web 登录与 SSO 的交互式登录 | `AuthStateStore::create` | 与用户不存在相同 |
| 所有监听端口上的工单、`POST /api/tickets/claim`、`?gated-ticket=` | `authorize_ticket` | 与工单不存在相同 |
| 管理 API 与 HTTP 代理上的 API 令牌 | `validate_api_token` 之后 | 与令牌不存在相同 |

客户端地址的取法与登录保护相同。已存在的浏览器会话不会因为列表变更或客户端换了地址而结束，需要时可在会话页面手动结束。
审计事件：`auth_address_not_allowed`、`ticket_address_not_allowed`、`api_token_address_not_allowed`。

### 强制 MFA

`parameters.mfa_required`（设置 > 安全，默认关闭）要求每个用户都绑定 OTP 设备，通过 SSO 登录的用户也不例外。
至少保存了一个 OTP 设备的用户视为“已绑定”。

| 路径 | 未绑定 | 已绑定 |
|---|---|---|
| Web 登录（密码或 SSO） | 按已保存的策略登录，之后只能访问绑定入口 | 必须提交 OTP 验证码，无论已保存的凭据策略如何（`RequiredFactorPolicy`） |
| 使用会话或用户 API 令牌访问管理 API | `403`，带响应头 `X-Gated-Mfa-Setup-Required: 1`，下述放行列表除外 | 不变 |
| SSH、MySQL、PostgreSQL 登录 | 在 `AuthStateStore::create` 中拒绝，应答与用户不存在相同 | 按已保存的凭据策略 |
| 使用 API 令牌或客户端证书访问 HTTP 代理 | `401` | 不变 |

未绑定用户可访问的内容（`mfa_setup_allows`）：`/ui` 下的页面、`GET /api/info`、`/api/auth` 与 `/api/sso`
下的登录、登出、SSO 和会话端点、启动门禁端点，以及 `POST /api/profile/credentials/otp/begin` 和
`POST /api/profile/credentials/otp`。即使不允许用户自行管理凭据，这两个绑定调用也可用。`/api/info` 返回
`mfa_setup_required`，Web 界面据此只显示绑定页面。

不在范围内：工单会话和管理令牌不是用户账号，不受限制。绑定之后，第二因素只在 Web 登录时强制；SSH 按已保存的策略
（绑定时会把 `Totp` 加入策略，已登记的公钥仍可单独登录），数据库协议没有第二因素。强制 MFA 期间，用户不能通过
`DELETE /api/profile/credentials/otp/:id` 删除最后一个 OTP 设备。管理员仍可删除，`gated recover-access`
也会删除被恢复用户的设备；之后用户在下次 Web 登录时重新绑定。在此之前，该账号与其他尚未绑定的账号一样，只受第一因素保护。
审计事件：`auth_mfa_setup_required`。

## API 令牌与 Web 会话

- **API 令牌**（`crates/gated-db-entities/src/ApiToken.rs`）：每用户、带标签和过期时间的密钥，以哈希存储，由
  `ConfigProvider::validate_api_token`（`crates/gated-core/src/config_providers/db.rs`）校验。在 HTTP 反向
  代理上以 `Authorization: Bearer` 接受，在门户 / 管理 API 上以 `X-Gated-Token` 接受。
- **管理令牌**：`gated run --enable-admin-token` 把 `GATED_ADMIN_TOKEN` 环境变量的值映射到第一个管理员
  用户 —— 用于自动化和 e2e 测试框架。
- **Web 会话**：cookie `gated-http-session`（`crates/gated-admin/src/http_service/common.rs`），服务端存储
  会话，cookie max-age（默认 24 小时）和会话 max-age（默认 30 分钟）分开设置，并按主机校验 cookie。登录时
  会更换会话标识。
- **身份变更时吊销**（`end_user_sessions`，`crates/gated-admin/src/http_service/session.rs`）：管理员为用户
  设置或移除密码，移除 OTP、公钥、SSO 或证书凭据，移除 `admin` 角色，重命名或删除用户时，该用户的浏览器会话
  结束、代理会话被关闭。凭据变更会保留发起变更的那个会话。会话按用户 id 匹配。

## 认证失败的行为

没有账户锁定。SSH 监听器在失败后应用 russh 的 1 秒延迟；认证结果计入 `gated_auth_attempts_total` 指标
（标签 `result`、`method`，`crates/gated-core/src/metrics.rs`）。每用户和每目标的
`rate_limit_bytes_per_second` 设置限制的是数据传输，而不是认证尝试。
