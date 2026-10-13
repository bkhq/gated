# Gated 后端 HTTP API 详细参考

本文档列出后端当前对外暴露的全部 HTTP 端点，并标注请求 / 响应结构。

约定：

- 路径中的参数以 `:name` 表示。
- `[OAS]` 表示 OpenAPI 路由（出现在 `/api/openapi.json` 或 `/admin/api/openapi.json`），`[raw]` 表示原始 / 升级类（WebSocket、SSE-like、文件流）。
- 字段类型用 TS 风格写：`string`、`number`、`uuid`（字符串）、`date-time`（RFC 3339 UTC 字符串）、`T[]`、`T | null`、`?: T`（可选）。
- 标注为 **secret — write-only** 的字段只在写入请求里出现；**secret — one-time reveal** 的字段只在创建响应里出现一次，之后任何 read 端点都不会再返回。

源代码来源：

- `crates/gated-admin/src/api/**` — 管理面 OpenAPI
- `crates/gated-admin/src/http_service/api/**` — 用户面 OpenAPI + 原始端点
- `crates/gated-admin/src/http_service/mod.rs`、`crates/gated-admin/src/lib.rs`、`crates/gated/src/commands/run.rs` — 显式 `at(..)` / `nest(..)` 挂载

---

## 1. 用户面 API（前缀 `/api`）

### 1.1 鉴权 (`auth.rs`)

#### `POST /api/auth/login` — `login` [OAS]

- Summary：使用用户名 + 密码开始或推进 HTTP 会话的 `AuthState`。
- Path / Query：无。
- Body (`Json<LoginRequest>`)：
  - `username: string`
  - `password: string`（secret — write-only）
- Responses：
  - `201 Created` — 空 body；poem `ServerSession` 写入或刷新名为 `gated-http-session` 的 cookie，会话里写入 `SessionAuthorization::User(username)`。
  - `401 Unauthorized` — `Json<LoginFailureResponse> { state: ApiAuthState }`。`Failed` = 拒绝；`*Needed` 表示密码通过但还需要其它因子。

#### `POST /api/auth/otp` — `otpLogin` [OAS]

- Summary：作为下一因子向当前会话的 `AuthState` 提交 TOTP。
- Body：`{ otp: string }`（secret — write-only）。
- Responses：
  - `201 Created` — 空 body；会话升级同 `login`。
  - `401 Unauthorized` — `Json<LoginFailureResponse>`；`NotStarted` 表示会话没有挂载 `auth_state_id`。

#### `POST /api/auth/logout` — `logout` [OAS]

- Summary：清空当前会话并解除其在 `SessionStore` 的服务端 handle。
- Body：无。
- Responses：`201 Created`，空 body。

#### `GET /api/auth/state` — `get_default_auth_state` [OAS]

- Summary：返回会话 `auth_state_id` 指向的进行中 `AuthState`。
- Responses：
  - `200 OK` — `Json<AuthStateDescription>`。
  - `404 Not Found` — 会话没有 `auth_state_id` 或在 store 中已不存在。

#### `DELETE /api/auth/state` — `cancel_default_auth` [OAS]

- Summary：强制拒绝会话上的进行中 `AuthState`，从 store 中移除并清掉会话里的 id。
- Responses：
  - `200 OK` — `Json<AuthStateDescription>`（`state: Failed`）。
  - `404 Not Found` — 会话没有挂载 state。

#### `GET /api/auth/web-auth-requests` — `get_web_auth_requests` [OAS]

- Summary：列出当前用户所有等待浏览器审批的 `AuthState`。Wrapped in `endpoint_auth`，必须是 `Session::User`。
- Responses：
  - `200 OK` — `Json<AuthStateDescription[]>`。
  - `404 Not Found` — 授权不是 `Session::User`（例如 `UserToken`/`AdminToken`/`Ticket`）。
  - `401 Unauthorized` — `endpoint_auth` 拒绝（无任何凭证）。

#### `GET /api/auth/state/:id` — `get_auth_state` [OAS]

- Summary：按 id 获取 `AuthState`，必须属于当前用户（按 username 校验）。
- Path：`id: uuid`。
- Responses：`200 OK` `Json<AuthStateDescription>` / `404` / `401`（同上）。

#### `POST /api/auth/state/:id/approve` — `approve_auth` [OAS]

- Summary：向指定 `AuthState` 添加 `WebUserApproval`；如已满足策略则 `complete`。
- Path：`id: uuid`。
- Responses：`200 OK` `Json<AuthStateDescription>`（可能为 `Success`）/ `404` / `401`。

#### `POST /api/auth/state/:id/reject` — `reject_auth` [OAS]

- Summary：拒绝指定 `AuthState`。
- Path：`id: uuid`。
- Responses：`200 OK` `Json<AuthStateDescription>`（`state: Failed`）/ `404` / `401`。

#### `GET /api/auth/web-auth-requests/stream` — `api_get_web_auth_requests_stream` [raw]

- 升级为 **WebSocket**（不是 SSE）。需要 `Session::User`，否则 `endpoint_auth` 返回 `401`。
- 升级后服务端每收到一条 `auth_state_store.subscribe_web_auth_request()` 广播且其 username 匹配当前用户时，发送一个 `Message::Text(payload)`，payload 是 `AuthState` 的纯 UUID 字符串。客户端收到后通过 `GET /api/auth/state/:id` 取详情。无心跳，发送或接收错误即关闭连接。

### 1.2 SSO (`sso_provider_list.rs`, `sso_provider_detail.rs`)

#### `GET /api/sso/providers` — `get_sso_providers` [OAS]

- Summary：列出已配置的 SSO 提供者（按 `label` 升序）。
- Responses：`200 OK` `Json<SsoProviderDescription[]>`。

#### `GET /api/sso/providers/:name/start` — `start_sso` [OAS]

- Summary：开始 SSO 流程；构造回调 URL（必须通过 provider 的 `return_domain_whitelist`），创建 `SsoLoginRequest`，并把 `SsoContext` 存入会话。
- Path：`name: string`。
- Query：`next?: string` — SSO 成功后回跳的相对路径（写入 `SsoContext.next_url`）。
- Responses：
  - `200 OK` — `Json<StartSsoResponseParams> { url: string }`。
  - `404 Not Found` — 未匹配到 provider。

#### `GET /api/sso/return` — `return_to_sso` [OAS]

- Summary：OAuth/OIDC 回调（provider 把浏览器带 `?code=` 带回这里）；验证 code、换 id-token、映射邮箱→用户名、完成 `AuthState`、应用 SSO 组→角色映射，然后 302/307 跳转到 `next_url`。
- Query：`code?: string`。
- Responses：
  - `307 Temporary Redirect` — `Location` 指向 `<next_url>`（成功）或 `/ui/?login_error=<msg>`（失败）。如果 `next_url` 以 `/` 开头且 `SsoContext.return_host` 已记录，会重写为 `https://<return_host><next_url>`。成功后会话升级为 user 会话并存储 `SsoLoginState`。

#### `POST /api/sso/return` — `return_to_sso_with_form_data` [OAS]

- Summary：`response_mode=form_post` 的 SSO 提供者使用的等价端点（Apple 等）。
- Body：`Form<ReturnToSsoFormData>`（`application/x-www-form-urlencoded`）`{ code?: string }`。
- Responses：`200 OK` `Html<string>` — 一段自动 `location.href = <url>` 的 HTML。

#### `GET /api/sso/logout` — `initiate_sso_logout` [OAS]

- Summary：使用会话里 `SsoLoginState` 的 id_token 在 IdP 发起 SLO；无论结果如何都先清掉本地会话。
- Responses：
  - `200 OK` — `Json<StartSloResponseParams> { url: string }`。
  - `400 Bad Request` — 会话没有 `SsoLoginState`。
  - `404 Not Found` — 已配置的 provider 已被删除。

### 1.3 实例信息与目标 (`info.rs`, `targets_list.rs`)

#### `GET /api/info` — `get_info` [OAS]

- Summary：用于 SPA 启动的实例 / 会话信息。
- Responses：`200 OK` `Json<Info>`。`site_title`（未设置为 `null`）对未鉴权请求同样返回，供登录页显示。未鉴权时 `version`、`ports.*` 均为 `null`；`setup_state` 仅对 admin 且 users 或 targets 计数 ≤ 1 时返回。

#### `GET /api/targets` — `get_targets` [OAS]

- Summary：列出当前主体可访问的目标。Wrapped in `endpoint_auth`。
- Query：`search?: string` — 不区分大小写子串，匹配 target.name 或 group.name。
- Responses：`200 OK` `Json<TargetSnapshot[]>`。Ticket 会话只会看到 ticket 绑定的那一个目标。

### 1.4 个人凭据 (`credentials.rs`)

> 全部路径外层包了 `parameters_based_auth`：如果 `parameters.allow_own_credential_management = false`，**所有**这些端点直接返回 `403 Forbidden` plain text `"Credential management is disabled"`，而不是 OpenAPI 枚举的 `403` 变体。

#### `GET /api/profile/credentials` — `get_my_credentials` [OAS]

- Responses：`200 OK` `Json<CredentialsState>` / `401 Unauthorized`（无法解析当前主体到 `User`）/ `403`（参数开关）。

#### `POST /api/profile/credentials/password` — `change_my_password` [OAS]

- Body：`{ password: string }`（secret — write-only）。
- Responses：`201 Created` `Json<PasswordState>`（字面量 `"Set"`）/ `401` / `403`。

#### `POST /api/profile/credentials/public-keys` — `add_my_public_key` [OAS]

- Body：`Json<NewPublicKeyCredential> { label: string, openssh_public_key: string }`。
- Responses：`201 Created` `Json<ExistingPublicKeyCredential>` / `401` / `403`。注意只返回 `abbreviated`，**不再返回完整 key**。

#### `DELETE /api/profile/credentials/public-keys/:id` — `delete_my_public_key` [OAS]

- Path：`id: uuid`。
- Responses：`204` / `401` / `404` / `403`。

#### `POST /api/profile/credentials/otp` — `add_my_otp` [OAS]

- Body：`Json<NewOtpCredential> { secret_key: byte[] }`（secret — write-only）。副作用：在 `http`/`ssh` 链上 push `Totp`。
- Responses：`201 Created` `Json<ExistingOtpCredential> { id: uuid }` / `401` / `403`。

#### `DELETE /api/profile/credentials/otp/:id` — `delete_my_otp` [OAS]

- 如果删除后用户已无 OTP，自动从凭据策略移除 `Totp` 要求。
- Responses：`204` / `401` / `404` / `403`。

#### `POST /api/profile/credentials/certificates` — `issue_my_certificate` [OAS]

- Body：`Json<IssueCertificateCredentialRequest> { label: string, public_key_pem: string }`。
- Responses：`201 Created` `Json<IssuedCertificateCredential>`，含 `credential` + `certificate_pem`（secret — one-time reveal）/ `401` / `403`。

#### `DELETE /api/profile/credentials/certificates/:id` — `revoke_my_certificate` [OAS]

- 写入 `CertificateRevocation` 行后删除凭据。
- Responses：`200 OK` 空 body（实现使用 `Ok` 变体而非 `Ok(Json)`）/ `401` / `404` / `403`。

### 1.5 个人 API Token (`api_tokens.rs`)

#### `GET /api/profile/api-tokens` — `get_my_api_tokens` [OAS]

- Responses：`200 OK` `Json<ExistingApiToken[]>` / `401`。

#### `POST /api/profile/api-tokens` — `create_api_token` [OAS]

- Body：`Json<NewApiToken> { label: string, expiry: date-time }`。
- Responses：`201 Created` `Json<TokenAndSecret> { token, secret }`（`secret` — one-time reveal）/ `401`。

#### `DELETE /api/profile/api-tokens/:id` — `delete_my_api_token` [OAS]

- Responses：`204` / `401` / `404`。

### 1.6 个人票据 (`tickets.rs`)

#### `GET /api/profile/tickets` — `get_my_tickets` [OAS]

- Responses：`200 OK` `Json<ExistingProfileTicket[]>` / `401`。

#### `POST /api/profile/tickets` — `create_my_ticket` [OAS]

- Body：`Json<NewProfileTicket>`：
  - `target_name: string`（trim 后不能为空）
  - `expiry?: date-time | null`（如有必须 > 现在）
  - `number_of_uses?: int16 | null`（如有必须 > 0）
  - `description?: string | null`
- Responses：
  - `201 Created` — `Json<ProfileTicketAndSecret> { ticket, secret }`（`secret` — one-time reveal）。
  - `400 Bad Request` — `Json<string>`：`"target_name is required"` / `"expiry must be in the future"` / `"number_of_uses must be positive"`。
  - `401` / `403 Forbidden` — `Json<string> "not authorized for this target"`。

#### `DELETE /api/profile/tickets/:id` — `delete_my_ticket` [OAS]

- Responses：`204` / `401` / `404`。

### 1.7 SQL 控制台 (`db_query.rs`)

> 所有 4 个端点的错误统一走 `DbError` 信封：`Json<ErrorBody> { error: string }`；`429` 还会带 `Retry-After: <seconds>`。状态码：`400 / 401 / 403 / 404 / 429 / 500 / 502`。

#### `GET /api/db/schemas/:target_name` — `get_db_schemas` [OAS]

- Path：`target_name: string`（`^[A-Za-z0-9._-]+$`，≤ 128 字符）。
- Responses：`200 OK` `Json<SchemaList> { schemas: string[], default_schema?: string, readonly: bool, kind: "MySql" | "Postgres" }`。系统库（`mysql`/`performance_schema`/`information_schema`/`sys`、`information_schema`/`pg_*`）已剔除。

#### `GET /api/db/tables/:target_name` — `get_db_tables` [OAS]

- Query：`schema: string`（必填，缺失 / 空 → `400 "schema query param required"`）。
- Responses：`200 OK` `Json<TableList> { tables: { name: string, type: string }[] }`。

#### `GET /api/db/columns/:target_name` — `get_db_columns` [OAS]

- Query：`schema: string`、`table: string`。
- Responses：`200 OK` `Json<ColumnList> { columns: { name, data_type, nullable, primary_key }[] }`。

#### `POST /api/db/query/:target_name` — `run_db_query` [OAS]

- Body：
  - `sql: string`（trim 后不能为空）
  - `limit?: int64 | null`（默认 1000，clamp 到 [1, 10000]）
  - `console_session_key?: string | null`（不同请求带相同 key 时被归入同一个 audit recording，session_id 取 SHA-256(key) 前 16 字节构成 UUIDv5 风格 id）
- Responses：`200 OK` `Json<QueryResponse>`（见 schemas 节）。
- 行为：执行前由 `validate_readonly_sql` 强制 readonly 约束（违反返回 `403`），服务端 30 s 超时，行 ≥ limit 或 JSON ≥ 5 MiB 时截断（`truncated: true`）。

### 1.8 终端 WebSocket（非 OpenAPI）

#### `GET /api/ssh/terminal/:target_name` — `api_ssh_terminal` [raw]

- 升级前校验：`target_name` 必须满足正则，否则 `400 "Invalid target name"`；未鉴权 `401 "Not authenticated"`；并发会话超 `MAX_SESSIONS_PER_USER = 10` 时 `429 "Too many concurrent terminal sessions"`。
- 升级后帧 = 二进制；首字节为消息类型，余下是 payload：
  - `0x00 MSG_TERMINAL_DATA` — 双向：原始终端字节。
  - `0x01 MSG_RESIZE` — 客户端 → 服务端：JSON `{ cols: u32, rows: u32 }`。
  - `0x02 MSG_STATUS` — 服务端 → 客户端：JSON `{ status, message }`，`status` ∈ `"info" | "connected" | "closed" | "error" | "rate_limited"`。
  - `0x03 MSG_HOST_KEY_VERIFY` — 仅当 `ssh.host_key_verification = prompt` 且远端 host key 未知：
    - 服务端 → 客户端：`{ status: "host_key_verify", algorithm, key_base64 }`。
    - 客户端 → 服务端：`{ accepted: bool }`，必须 60 s 内到达。
- Keepalive：服务端每 30 s `Ping`。无自定义 close code，错误用最后一帧 `MSG_STATUS` 反馈。

#### `GET /api/mysql/terminal/:target_name` — `api_mysql_terminal` [raw]
#### `GET /api/postgres/terminal/:target_name` — `api_postgres_terminal` [raw]

- 服务端 fork 真实的 `mysql` / `psql` 二进制，把 PTY 桥接到 WS。账号、密码（`MYSQL_PWD`/`PGPASSWORD`）、TLS 模式、host/port/默认库均来自目标的存储配置。
- 升级前 `400 / 401`；超过 `sql_console_rate_limiter` 时升级后立即发送 `MSG_STATUS {status:"rate_limited",...}` 并关闭。
- 帧格式同 SSH，但 `MSG_RESIZE` 使用 `u16`，无 `0x03`。`MSG_STATUS.status` ∈ `"connected" | "error" | "rate_limited"`。

### 1.9 OpenAPI 元数据

- `GET /api/openapi.json` — 规范。
- `GET /api/playground` — Stoplight Elements UI。

---

## 2. 管理面 API（前缀 `/admin/api`）

### 2.1 会话 (`sessions_list.rs`, `sessions_detail.rs`)

#### `GET /admin/api/sessions` — `get_sessions` [OAS]

- Query：`offset?: u64`（默认 0）、`limit?: u64`（默认 100）、`active_only?: bool`（默认 false）、`logged_in_only?: bool`（默认 false）。
- Responses：`200 OK` `Json<PaginatedResponse<SessionSnapshot>>`。

#### `DELETE /admin/api/sessions` — `close_all_sessions` [OAS]

- 关闭内存中所有活跃会话并清掉调用者自身的 cookie 会话。
- Responses：`201 Created`，空 body。

#### `GET /admin/api/sessions/:id` — `get_session` [OAS]

- Responses：`200 OK` `Json<SessionSnapshot>` / `404`。

#### `GET /admin/api/sessions/:id/recordings` — `get_session_recordings` [OAS]

- Responses：`200 OK` `Json<Recording[]>`（按 started 倒序）。

#### `POST /admin/api/sessions/:id/close` — `close_session` [OAS]

- Responses：`201 Created` 空 body / `404`（会话当前不在 state 中）。

#### `GET /admin/api/sessions/changes` — `api_get_sessions_changes_stream` [raw]

- 升级为 WebSocket（**不是** SSE）。每次全局会话广播触发时发送一个空 `Text("")` 帧（"有变化，请重新拉取"）。

### 2.2 录像 (`recordings_detail.rs` + `lib.rs` raw)

#### `GET /admin/api/recordings/:id` — `get_recording` [OAS]

- Responses：`200 OK` `Json<Recording>` / `404`。

#### `GET /admin/api/recordings/:id/http-proxy` — `get_http_proxy_recording` [OAS]

- 注意：实现未声明鉴权（无 `AnySecurityScheme` 参数）。
- Responses：`200 OK` `Json<HttpProxyRecordingItem[]>`；当录像不存在或不是 `http_proxy` 时由 poem `NotFoundError` 抛出 `404`。

#### `GET /admin/api/recordings/:id/cast` — `api_get_recording_cast` [raw]

- 返回 asciinema asciicast v2 流；`Content-Type: text/plain; charset=utf-8`，每行一个 JSON 值，以 `\n` 分隔。首行 `{"version":2,"width":W,"height":H,"title":<name>,"time":0.0}`；后续行要么是新的 header（PTY resize），要么是 `[time, "i"|"o"|"e", data]`。
- `404` 当录像缺失或不是 `terminal`；`500` 文件 / JSON 错误。

#### `GET /admin/api/recordings/:id/stream` — `api_get_recording_stream` [raw]

- 升级 WebSocket。首条文本帧 `{ start: true, live: bool }`。`live` 时后续 `{ data: AsciiCast }`，最后 `{ end: true }`；`!live` 时只发 start。

#### `GET /admin/api/recordings/:id/tcpdump` — `api_get_recording_tcpdump` [raw]

- `Content-Type: application/octet-stream`，原始 pcap 字节。
- `404` 当录像缺失或不是 `traffic`；`500` 文件 IO 错误。

### 2.3 用户 (`users.rs`)

#### `GET /admin/api/users` — `get_users` [OAS]

- Query：`search?: string` — `LIKE %search%`。
- Responses：`200 OK` `User[]`。

#### `POST /admin/api/users` — `create_user` [OAS]

- Body：`CreateUserRequest { username: string, description?: string }`。
- Responses：`201 Created` `User` / `400` `"name"`（用户名为空）。

#### `GET /admin/api/users/:id` — `get_user` [OAS]

- Responses：`200 OK` `User` / `404`。

#### `PUT /admin/api/users/:id` — `update_user` [OAS]

- Body：`UserDataRequest { username, credential_policy?, description?, rate_limit_bytes_per_second? }`。
- Responses：`200 OK` `User` / `404`。

#### `DELETE /admin/api/users/:id` — `delete_user` [OAS]

- 同时删除角色绑定。
- Responses：`204` / `404`。

#### `GET /admin/api/users/:id/roles` — `get_user_roles` [OAS]
- `200 OK` `Role[]` / `404`。

#### `POST /admin/api/users/:id/roles/:role_id` — `add_user_role` [OAS]
- `201 Created` 空 body / `409` 已存在。

#### `DELETE /admin/api/users/:id/roles/:role_id` — `delete_user_role` [OAS]
- `204` / `404`。

### 2.4 用户凭据子资源

#### 密码 (`password_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/passwords` — `200 OK` `ExistingPasswordCredential[]`（只有 `{ id }`）。
- `POST /admin/api/users/:user_id/credentials/passwords` — Body `{ password: string }`（secret — write-only），`201 Created` `ExistingPasswordCredential`。
- `DELETE /admin/api/users/:user_id/credentials/passwords/:id` — `204` / `404`。

#### 公钥 (`public_key_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/public-keys` — `200 OK` `ExistingPublicKeyCredential[]`。
- `POST /admin/api/users/:user_id/credentials/public-keys` — Body `{ label, openssh_public_key }`，`201` `ExistingPublicKeyCredential`。
- `PUT /admin/api/users/:user_id/credentials/public-keys/:id` — 同 Body，`200` / `404`。
- `DELETE /admin/api/users/:user_id/credentials/public-keys/:id` — `204` / `404`。

#### OTP (`otp_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/otp` — `200 OK` `ExistingOtpCredential[]`（`{ id }`）。
- `POST /admin/api/users/:user_id/credentials/otp` — Body `{ secret_key: byte[] }`（secret — write-only），`201` `ExistingOtpCredential`。
- `DELETE /admin/api/users/:user_id/credentials/otp/:id` — 当用户最后一个 OTP 被删时同步从 policy 移除 OTP 要求，`204` / `404`。

#### SSO (`sso_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/sso` — `200 OK` `ExistingSsoCredential[]`。
- `POST /admin/api/users/:user_id/credentials/sso` — Body `{ provider?: string | null, email: string }`，`201` `ExistingSsoCredential`。
- `PUT /admin/api/users/:user_id/credentials/sso/:id` — 同 Body，`200` / `404`。
- `DELETE /admin/api/users/:user_id/credentials/sso/:id` — `204` / `404`。

#### 证书 (`certificate_credentials.rs`)

- `GET /admin/api/users/:user_id/credentials/certificates` — `200 OK` `ExistingCertificateCredential[]`。
- `POST /admin/api/users/:user_id/credentials/certificates` — Body `{ label, public_key_pem }`，`201` `IssuedCertificateCredential`（含 `certificate_pem`，secret — one-time reveal）。
- `PATCH /admin/api/users/:user_id/credentials/certificates/:id` — Body `{ label }`，`200` / `404`。
- `DELETE /admin/api/users/:user_id/credentials/certificates/:id` — 写入 `CertificateRevocation` 行后删除凭据，`204` / `404`。

#### API Token (`api_tokens.rs`)

- `GET /admin/api/users/:user_id/api-tokens` — `200 OK` `ExistingApiToken[]`。
- `POST /admin/api/users/:user_id/api-tokens` — Body `{ label, expiry: date-time }`：
  - `201 Created` `TokenAndSecret`（`secret` — one-time reveal）。
  - `400` `"expiry must be in the future"` / `"label is required"`。
- `DELETE /admin/api/users/:user_id/api-tokens/:id` — `204` / `404`。

### 2.5 目标 (`targets.rs`)

#### `GET /admin/api/targets` — `get_targets` [OAS]

- Query：`search?: string`、`group_id?: uuid`。
- Responses：`200 OK` `Target[]`。绑定了账号的目标 inline 凭据整体清空；未绑定账号的目标保留用户名与认证方式，仅清空密钥字段。`accounts` 已填充，`allow_roles` 为绑定的 role ids（字符串）。

#### `POST /admin/api/targets` — `create_target` [OAS]

- Body：`TargetDataRequest`：
  - `name: string`（非空）
  - `description?: string`
  - `options: TargetOptions`
  - `accounts?: TargetAccountBinding[]`（`{ account_id: i32, role: "primary"|"fallback"|"readonly" }`；非空列表进入 account-mode 并清空 inline 凭据；空列表 `[]` 表示使用 inline 凭据并移除已有绑定；省略则不改动绑定）
  - `rate_limit_bytes_per_second?: u32`
  - `group_id?: uuid`
- Responses：
  - `201 Created` `Target`。
  - `400` `"name"`（空名）。
  - `409` `"Name already exists"`。
  - `422` `"accounts cannot be mixed with inline credentials"` / `"accounts must include a primary binding"` / `"account {id} not found"` / `"account {id} kind {kind} is not compatible with target kind"`。

#### `GET /admin/api/targets/:id` — `get_target` [OAS] — `200` / `404`。

#### `PUT /admin/api/targets/:id` — `update_target` [OAS]

- Body 同 create。`options` 的 `kind` 必须与已存储记录一致。
- inline 模式下，密钥字段留空（且认证方式未变）会保留已存储的密钥，因此 GET → PUT 往返不会抹掉密钥。
- 更新后会重应用 rate limit 并使该目标的 DB pool 失效。
- Responses：`200` / `400`（kind 不一致，空 body）/ `404` / `422`（同 create）。

#### `DELETE /admin/api/targets/:id` — `delete_target` [OAS]

- 同步删除角色绑定；SSH 目标会删除其 host:port 对应的 known-hosts；使该目标的 DB pool 失效。
- Responses：`204` / `404`。

#### `GET /admin/api/targets/:id/known-ssh-host-keys` — `get_ssh_target_known_ssh_host_keys` [OAS]

- Responses：`200 OK` `SSHKnownHost[]` / `400`（目标不是 SSH）/ `404`。

#### `GET /admin/api/targets/:id/roles` — `get_target_roles` [OAS] — `200` `Role[]` / `404`。
#### `POST /admin/api/targets/:id/roles/:role_id` — `add_target_role` [OAS] — `201` / `409`。
#### `DELETE /admin/api/targets/:id/roles/:role_id` — `delete_target_role` [OAS] — `204` / `404`。

### 2.6 目标组 (`target_groups.rs`)

- `GET /admin/api/target-groups` — `200 OK` `TargetGroup[]`（按 name）。
- `POST /admin/api/target-groups` — Body `{ name, description?, color?: BootstrapThemeColor }`：`201 Created` `TargetGroup` / `400 "name"` / `409 "Name already exists"`。
- `GET /admin/api/target-groups/:id` — `200` / `404`。
- `PUT /admin/api/target-groups/:id` — Body 同 create；重名走 `400`；`200` / `400` / `404`。
- `DELETE /admin/api/target-groups/:id` — 先把引用该组的目标 `group_id` 置 NULL 再删除；`204` / `404`。

### 2.7 角色 (`roles.rs`)

- `GET /admin/api/roles` — Query `search?`；`200` `Role[]`。
- `POST /admin/api/roles` — Body `{ name, description? }`；`201` `Role` / `400 "name"`。
- `GET /admin/api/role/:id` — `200` / `404`。
- `PUT /admin/api/role/:id` — Body 同 create；不能改 builtin admin；`200` / `403` / `404`。
- `DELETE /admin/api/role/:id` — 不能删 builtin admin；`204` / `403` / `404`。
- `GET /admin/api/role/:id/targets` — `200` `Target[]` / `404`。
- `GET /admin/api/role/:id/users` — `200` `User[]` / `404`。

### 2.8 共享账户 (`accounts.rs`)

#### `GET /admin/api/accounts` — `get_accounts` [OAS]

- Query：
  - `kind?: string`
  - `tag?: string` — 在序列化后的 JSON tags 上做 `"<tag>"` 子串匹配
  - `q?: string` — `name` 或 `description` 子串
  - `page?: u64`（默认 1，clamp ≥ 1）
  - `page_size?: u64`（默认 100，clamp 到 1..=500）
- Responses：`200 OK` `AccountSummary[]`（不带总数 / offset 包装）。

#### `POST /admin/api/accounts` — `create_account` [OAS]

- Body：`AccountCreate { kind, name, description?, credentials: object, tags? }`。
- Responses：
  - `201 Created` `AccountSummary`。
  - `400` `"name is required"`。
  - `409` `"name already exists"`。
  - `422` `"credentials must be a JSON object"` / `"credentials kind \"X\" does not match account kind \"Y\""` / `"invalid credentials for kind \"X\": ..."`。

#### `GET /admin/api/accounts/:id` — `get_account` [OAS]

- Responses：
  - `200 OK` `AccountDetail`（`AccountSummary` 平铺 + `credentials_schema: { kind, fields: { [name]: { present, sensitive } } }`，明文 secret 不返回）。
  - `404` / `422`（存储的凭据无法反序列化）。

#### `PUT /admin/api/accounts/:id` — `update_account` [OAS]

- Body：`AccountUpdate { name?, description?, credentials?, tags?, rotation_due_at?, clear_rotation_due_at? }`，每个字段独立可选；`credentials` 必须匹配现有 `kind`；`clear_rotation_due_at: true` 清空。
- Responses：`200` `AccountSummary` / `400 "name is required"` / `404` / `409 "name already exists"` / `422`（凭据校验错误）。

#### `DELETE /admin/api/accounts/:id` — `delete_account` [OAS]

- Responses：
  - `204` 已删除。
  - `404`。
  - `409` `AccountDeleteConflict { error: "account_in_use", reference_count: u32, references: AccountReference[] }`。

#### `POST /admin/api/accounts/:id/reveal` — `reveal_account` [OAS]

- Summary：校验调用者身份后返回明文 `credentials`，并写审计日志（`account.credentials.reveal`，含 actor、reason、确认方式）。仅限有用户名的调用者（共享 admin token 返回 `401`）。按调用者每分钟 10 次、按调用者 + 账户每分钟 5 次限流；同一用户 120 秒内 OTP 确认只能使用一次。
- Request：`RevealConfirmation { reason?: string, password?: string, otp?: string }`；`reason` 可省略，提供时不超过 500 字符，`password` 与 `otp`（6 位数字）必须且只能提供其一。
- Responses：
  - `200 OK` `AccountReveal { credentials: AccountCredentials }`（全部 secret — one-time reveal），带 `Cache-Control: no-store`。
  - `400` 请求体不满足上述约束。
  - `401` 无用户名、确认失败或 OTP 重用。
  - `429` 超出限流。
  - `404` / `422`（存储的凭据无法解析）。

#### `GET /admin/api/accounts/:id/references` — `get_account_references` [OAS]

- Responses：`200 OK` `AccountReference[]` / `404`。

### 2.9 票据 (`tickets_list.rs`, `tickets_detail.rs`)

#### `GET /admin/api/tickets` — `get_tickets` [OAS]

- Responses：`200 OK` `Json<Ticket[]>`（`Ticket.secret` 字段 `#[oai(skip)]`，不返回）。

#### `POST /admin/api/tickets` — `create_ticket` [OAS]

- Body：`CreateTicketRequest { username, target_name, expiry?: date-time, number_of_uses?: i16, description? }`。
- Responses：
  - `201 Created` `TicketAndSecret { ticket: Ticket, secret: string }`（`secret` — one-time reveal）。
  - `400` `Json<string>`：`"username"` 或 `"target_name"`。

#### `DELETE /admin/api/tickets/:id` — `delete_ticket` [OAS] — `204` / `404`。

### 2.10 SSH 主机密钥与探测 (`ssh_keys.rs`, `known_hosts_list.rs`, `known_hosts_detail.rs`, `ssh_connection_test.rs`)

- `GET /admin/api/ssh/own-keys` — `200 OK` `Json<SSHKey[]>`（`{ kind, public_key_base64 }`）。网关自身的 SSH 客户端公钥列表。
- `POST /admin/api/ssh/known-hosts` — Body `AddSshKnownHostRequest { host, port: i32, key_type, key_base64 }`；`200 OK` `Json<SSHKnownHost>`。
- `GET /admin/api/ssh/known-hosts` — `200 OK` `Json<SSHKnownHost[]>`。
- `DELETE /admin/api/ssh/known-hosts/:id` — `204` / `404`。
- `POST /admin/api/ssh/check-host-key` — Body `{ host: string, port: u16 }`；`200 OK` `{ remote_key_type, remote_key_base64 }` / `500 PlainText<string>`（人类可读错误链）。

### 2.11 日志、参数 (`logs.rs`, `parameters.rs`)

#### `POST /admin/api/logs` — `get_logs` [OAS]

- Body：`GetLogsRequest`：
  - `before?: date-time`、`after?: date-time`（如设了 `after`，按时间升序返回）
  - `limit?: u64`（默认 100）
  - `session_id?: uuid`
  - `username?: string` — 匹配日志行的 `username` 列
  - `search?: string` — 子串匹配 `text` / `username` / `values`
  - `target_name?: string` — 匹配会话 `target_snapshot.name`
- Responses：`200 OK` `Json<LogEntry[]>`。
- 只包含会话面的审计事件；`m00010` 之前写入的历史管理操作记录也保留在这里。

#### `POST /admin/api/management-audit` — `get_management_audit` [OAS]

- Body：同 `GetLogsRequest`（`target_name` 非空时直接返回空数组）。
- Responses：`200 OK` `Json<LogEntry[]>`，数据来自独立的 `management_audit` 表：每个有身份的管理写操作各有 `requested` / `completed` 两条（`values.event = "management.action"`），以及 `session.delete`、`account.credentials.reveal` 事件。
- 本接口与 `/admin/api/logs` 都是只读查询，虽然用 POST，但不会被管理审计记录。

#### `GET /admin/api/parameters` — `get_parameters` [OAS]

- Responses：`200 OK` `Json<ParameterValues>`：
  - `allow_own_credential_management: bool`
  - `rate_limit_bytes_per_second?: u32`（`null` 表示无限制）
  - `ssh_client_auth_publickey: bool`、`ssh_client_auth_password: bool`、`ssh_client_auth_keyboard_interactive: bool`
  - `minimize_password_login: bool`
  - `sql_console_rate_limit_per_user?: u32`、`sql_console_rate_limit_per_target?: u32`
  - `terminal_watermark_enabled: bool`
  - `site_title?: string`（`null` 表示使用内置标题 “Gated”）

#### `PUT /admin/api/parameters` — `update_parameters` [OAS]

- Body `ParameterUpdate`：
  - 必填：`allow_own_credential_management`
  - 总会写：`rate_limit_bytes_per_second?`、`sql_console_rate_limit_per_user?`、`sql_console_rate_limit_per_target?`（`null` 清空）
  - 部分字段（缺省 = 保留旧值）：`ssh_client_auth_publickey?`、`ssh_client_auth_password?`、`ssh_client_auth_keyboard_interactive?`、`minimize_password_login?`、`terminal_watermark_enabled?`
  - `site_title?: string`：缺省保留旧值；去除首尾空白后为空则清除（恢复 “Gated”）；最多 64 个字符，不能包含控制字符。
- Responses：`201 Created`（变体 `Done`），空 body；`400` `Json<string>`（`site_title` 不合法）。

### 2.12 OpenAPI 元数据

- `GET /admin/api/openapi.json`
- `GET /admin/api/playground`

### 2.13 浏览器登录会话 (`management_sessions.rs`)

浏览器登录会话保存在内存中的管理会话注册表里，不在 `sessions` 表中，重启后全部失效。

#### `GET /admin/api/management-sessions` — `get_management_sessions` [OAS]

- Responses：`200 OK` `ManagementSession[]`：`{ id: uuid, username: string, created: date-time, last_active: date-time, current: bool }`，按登录时间升序；`current` 表示调用者自己的会话。未完成登录的会话不列出。

#### `DELETE /admin/api/management-sessions/:id` — `revoke_management_session` [OAS]

- Responses：`204` 已撤销，该 cookie 在下一次请求时失效；`404` 不存在。

---

## 3. 加密 / 解锁管理（前缀 `/api/admin/encryption`）

非 OpenAPI 路由，由 `crates/gated-admin/src/http_service/api/encryption.rs` 直接处理；同时也由解锁前的最小 HTTP 服务暴露。`/init` 与 `/unlock` 共享一个 `governor` 按客户端 IP 限速：**每分钟 5 次**。超限响应 `429 Too Many Requests` 体 `{ "code": "rate_limited", "message": "Too many attempts", "retry_after": 60 }`。

#### `GET /api/admin/encryption/lock-status` — `lock_status`

- Auth：无。
- Response 200：`{ status: "disabled" | "uninitialized" | "locked" | "unlocked" | "error", db_ready: bool, retry_after: null }`。

#### `GET /api/admin/encryption/status` — 同 `lock-status`（注册的别名）

#### `POST /api/admin/encryption/init` — `init`

- Auth：bootstrap token（一次性，启动时随机生成，存放在 `data/` 下）；按 IP 限速。
- Body：`{ bootstrap_token: string, master_password: string }`。
- Responses：
  - `201` `{ "status": "unlocked", "plaintext_backup": string | null }`。对已有明文 SQLite 数据库完成迁移时，`plaintext_backup` 为服务器上保留的未加密副本路径（同时写一条 `encryption_plaintext_backup_retained` 审计日志），运维确认后需手动删除。
  - `409` `encryption_disabled` / `already_initialized` / `database_detection_failed` / `database_not_plaintext` / `init_failed`。
  - `403` `forbidden`（token 不匹配或服务端没有 token）。
  - `401` `unauthorized`（设置 DEK 后打开加密 DB 失败；runtime 已回到 locked，DB 已关闭）。
  - `429` `rate_limited`（`retry_after: 60`）。

#### `POST /api/admin/encryption/unlock` — `unlock`

- Auth：仅需 master password；按 IP 限速。
- Body：`{ master_password: string }`。
- Responses：
  - `200` `{ "status": "unlocked" }`。
  - `409` `encryption_disabled` / `invalid_state`。
  - `401` `unauthorized`（密码错误或解锁后打开 DB 失败）。
  - `429` `rate_limited`。

#### `POST /api/admin/encryption/lock` — `lock`

- Auth：必须是 admin。`401`/`403` 走 poem 默认空 body 错误映射。
- Responses：`200` `{ "status": "locked" }` / `409` `encryption_disabled` / `invalid_state` / `401` / `403`。

#### `POST /api/admin/encryption/rekey-master` — `rekey_master`

- Auth：admin。
- Body：`{ old_password: string, new_password: string }`。
- Responses：
  - `200` `{ "status": "unlocked" }`。
  - `409` `encryption_disabled` / `invalid_state`。
  - `401` `unauthorized`（旧密码错）/ `401`/`403`（缺少 / 非 admin 鉴权）。

---

## 4. 观测 / 健康检查（独立监听端口；仅当 `metrics.enable = true` 时挂载）

#### `GET /metrics` — `metrics_endpoint`

- 无鉴权（依赖 loopback 绑定 / 网络策略）。
- `200 OK` Prometheus 文本暴露格式（`Content-Type: text/plain; version=0.0.4`）。

#### `GET /healthz` — `healthz_endpoint`

- 无鉴权；也挂载在主 HTTP 端口与解锁前的最小 HTTP 服务上。
- `200 OK` 文本 `ok`。

#### `GET /readyz` — `readyz_endpoint`

- Summary：跑 `deep_check`（`skip_lookups: true`，因此跳过 SSO 探测），1500 ms outer timeout。
- Status：`ok`/`warn` → `200`；`fail` → `503`。
- Body — `DeepHealthReport`：

  ```json
  {
    "status": "ok" | "warn" | "fail",
    "generated_at": "<RFC3339 UTC>",
    "checks": [
      { "name": "<id>", "status": "ok" | "warn" | "fail", "message": "<optional>" }
    ]
  }
  ```

  内置 check：
  - `db.ping` — 700 ms 内 `SELECT 1`。
  - `db.migrations` — 700 ms；有待执行迁移 → `fail`，message `"<N> pending migration(s): <names>"`。
  - `db.tx_roundtrip` — 700 ms 内 `BEGIN`+`COMMIT`。
  - `tls.cert` — 解析 `http.certificate`；`http.tls = false` 时 ok（`"HTTPS disabled — no cert to check"`）。`< 7 天` → warn；过期 / 不可读 / 不可解析 → fail；否则 ok（`"valid for <N> day(s)"`）。
  - `deep_check` — 仅在 outer timeout 触发时合成单条 fail，message `"deep check exceeded 1500ms guard"`。

---

## 5. 静态资源 / SPA

- `/ui/*` — 内嵌前端 (`gated-web` Assets)。
- `/` — 顶层 catchall（登录前页面、错误页等）。

---

## 6. 共享 Schemas

### 6.1 鉴权相关

#### `AuthStateDescription`

```
{
  id: string,                              // AuthState 的 uuid
  protocol: string,                        // "HTTP" | "SSH" | "MySQL" | "PostgreSQL" | "Kubernetes"
  address: string | null,                  // 来源 IP（如有）
  started: date-time,
  state: ApiAuthState,
  identification_string: string            // 4 字符大写 hex，作为浏览器审批确认码
}
```

#### `ApiAuthState`

`NotStarted | Failed | PasswordNeeded | OtpNeeded | SsoNeeded | WebUserApprovalNeeded | PublicKeyNeeded | Success`。

选择顺序 `PREFERRED_NEED_CRED_ORDER`：`PublicKey, Password, Totp, Sso, WebUserApproval`。

#### `LoginRequest` / `LoginFailureResponse` / `OtpLoginRequest`

- `LoginRequest { username: string, password: string }`
- `LoginFailureResponse { state: ApiAuthState }`
- `OtpLoginRequest { otp: string }`

#### `SsoProviderDescription` / `StartSsoResponseParams` / `StartSloResponseParams` / `ReturnToSsoFormData`

- `SsoProviderDescription { name: string, label: string, kind: "Google" | "Apple" | "Azure" | "Custom" }`
- `StartSsoResponseParams { url: string }`、`StartSloResponseParams { url: string }`
- `ReturnToSsoFormData { code?: string }`

#### 会话 Cookie

名称 `gated-http-session`。`Secure` = `http.tls`；`Max-Age` = `http.cookie_max_age`；`Domain` 取 `http.cookie_domain` 或派生的 `.<external_host>`，本地 / 裸 IP 时由 `CookieHostMiddleware` 自动剥离。

### 6.2 实例 / 目标

#### `Info` / `PortsInfo` / `SetupState`

```
Info {
  version: string | null,                  // gated_version()，未鉴权时 null
  username: string | null,
  admin: bool,
  selected_target: string | null,
  external_host: string | null,
  ports: PortsInfo,
  minimize_password_login: bool,
  authorized_via_ticket: bool,
  authorized_via_sso_with_single_logout: bool,
  own_credential_management_allowed: bool,
  setup_state: SetupState | null
}
PortsInfo { ssh: u16|null, http: u16|null, mysql: u16|null, postgres: u16|null, kubernetes: u16|null }
SetupState { has_targets: bool, has_users: bool }
```

#### `TargetSnapshot` / `GroupInfo`

```
TargetSnapshot {
  name: string,
  description: string,
  kind: "http" | "mysql" | "ssh" | "postgres",
  group: GroupInfo | null,
  default_database_name: string | null
}
GroupInfo { id: uuid, name: string, color: BootstrapThemeColor | null }
```

`BootstrapThemeColor` ∈ `"primary" | "secondary" | "success" | "danger" | "warning" | "info" | "light" | "dark"`。

### 6.3 用户与角色

#### `User`

```
{
  id: uuid,
  username: string,
  description: string,
  require?: UserRequireCredentialsPolicy,  // serde 字段名 "require"，Rust 字段是 credential_policy
  rate_limit_bytes_per_second: number | null
}
```

#### `UserRequireCredentialsPolicy`

每个协议字段都 `Option<Vec<CredentialKind>>`，缺省时不出现：

```
{ http?: CredentialKind[], kubernetes?: CredentialKind[], ssh?: CredentialKind[],
  mysql?: CredentialKind[], postgres?: CredentialKind[] }
```

`CredentialKind` 序列化值（lowercase）：`"password" | "publickey" | "certificate" | "otp" | "sso" | "web"`。

#### `Role`

`{ id: uuid, name: string, description: string }`。

### 6.4 凭据

```
ExistingPasswordCredential       { id: uuid }
NewPasswordCredential            { password: string }                               // secret — write-only

ExistingPublicKeyCredential      { id, label, date_added?, last_used?,
                                   openssh_public_key? OR abbreviated }
NewPublicKeyCredential           { label: string, openssh_public_key: string }

ExistingOtpCredential            { id: uuid }
NewOtpCredential                 { secret_key: byte[] }                             // secret — write-only

ExistingSsoCredential            { id: uuid, provider: string | null, email: string }
NewSsoCredential                 { provider?: string | null, email: string }

ExistingCertificateCredential    { id, label, date_added?, last_used?, fingerprint } // sha256 hex
IssueCertificateCredentialRequest{ label: string, public_key_pem: string }
IssuedCertificateCredential      { credential: ExistingCertificateCredential,
                                   certificate_pem: string }                        // secret — one-time reveal
UpdateCertificateCredential      { label: string }
```

注：用户面 `add_my_public_key` 返回的 `ExistingPublicKeyCredential` 含 `abbreviated`（首 10 + `...` + 末 10）且不返回完整 key；admin 面返回的是包含完整 `openssh_public_key` 的版本。

#### API Token

```
ExistingApiToken { id: uuid, user_id?: uuid, label, created: date-time, expiry: date-time }
NewApiToken      { label: string, expiry: date-time }
TokenAndSecret   { token: ExistingApiToken, secret: string }                        // secret — one-time reveal
```

### 6.5 票据

```
Ticket {                                  // admin 视角，secret 字段 #[oai(skip)]
  id: uuid, username, description, target,
  uses_left?: int16, expiry?: date-time, created: date-time
}
CreateTicketRequest { username, target_name, expiry?, number_of_uses?: i16, description? }
TicketAndSecret     { ticket: Ticket, secret: string }                              // secret — one-time reveal

ExistingProfileTicket  { id, target, description, uses_left?, expiry?, created }
NewProfileTicket       { target_name, expiry?, number_of_uses?: i16, description? }
ProfileTicketAndSecret { ticket: ExistingProfileTicket, secret: string }            // secret — one-time reveal
```

### 6.6 目标

#### `Target`（admin 列表 / 详情）

```
{
  id: uuid,
  name: string,
  description: string,
  allow_roles: string[],
  kind: "ssh" | "http" | "mysql" | "postgres",
  ...variant-fields-flattened,
  accounts: TargetAccountMetadata[],
  rate_limit_bytes_per_second: u32 | null,
  group_id: uuid | null
}
```

`TargetOptions` 变体（按 `kind` 平铺到外层）：

- `ssh` — `TargetSSHOptions { host, port: u16=22, username="root", allow_insecure_algos?: bool, auth: SSHTargetAuth }`
- `http` — `TargetHttpOptions { url, tls: Tls, ca_certificate?: secret, upstream_auth: UpstreamAuth, flavor: "generic" | "kubernetes" }`
- `mysql` — `TargetMySqlOptions { host, port: u16=3306, username="root", password?: secret, tls, default_database_name?, readonly: bool }`
- `postgres` — `TargetPostgresOptions { host, port, username, password?: secret, tls, idle_timeout?, default_database_name?, readonly }`

```
Tls            { mode: TlsMode, verify: bool }
SSHTargetAuth  { kind: "password", password: secret }
             | { kind: "publickey", private_key_pem?: secret, passphrase?: secret }
UpstreamAuth   { kind: "none" }
             | { kind: "headers", headers: { [name]: secret } }
             | { kind: "bearer_token", token: secret }
             | { kind: "client_certificate", certificate: secret, private_key: secret }
TargetAccountMetadata { account_id: i32, account_name, kind, role: "primary"|"fallback"|"readonly" }
```

inline secret 在 list/read 端点会被清空（不会泄漏明文）；未绑定账号时用户名与认证方式保留。

#### `TargetGroup`

`{ id: uuid, name, description, color: BootstrapThemeColor | null }`。

#### `SSHKnownHost`

`{ id: uuid, host: string, port: i32, key_type: string, key_base64: string }`。

### 6.7 共享账户

```
AccountSummary {
  id: i32, kind, name, description: string | null, tags: string[] | null,
  created_by: uuid | null, created_at, updated_at, last_used_at: date-time | null,
  rotation_due_at: date-time | null, reference_count: u32
}
AccountDetail = AccountSummary + { credentials_schema: { kind, fields: { [name]: { present, sensitive } } } }
AccountReference        { target_id, target_name, target_kind, role }
AccountDeleteConflict   { error: "account_in_use", reference_count: u32, references: AccountReference[] }
AccountReveal           { credentials: AccountCredentials }
```

`AccountCredentials`（discriminator `kind` kebab-case）：

- `ssh-password { username, password: secret }`
- `ssh-key { username, private_key_pem: secret, passphrase?: secret }`
- `db-password { engine: "mysql"|"postgres", username, password: secret }`
- `k8s-token { token: secret, ca_pem?: secret, namespace? }`
- `k8s-client-cert { client_certificate_pem, client_private_key_pem: secret, passphrase?: secret, ca_pem?: secret, namespace? }`
- `http-headers { headers: { name, value: secret, sensitive?: bool }[] }`

明文 secret 仅在 `POST /admin/api/accounts/:id/reveal` 中返回。

### 6.8 会话与录像

```
SessionSnapshot {
  id: uuid, username?: string, target?: Target | null,
  started: date-time, ended?: date-time, ticket_id?: uuid, protocol: string
}
Recording {                                // 数据库实体；OAS 名 "Recording"
  id: uuid, name, started, ended?, session_id,
  kind: "Terminal" | "Traffic" | "HttpProxy" | "SqlAudit", metadata: string
}
HttpProxyRecordingItem {
  timestamp, request_method, request_path, request_body: any,
  response_status?: u16, response_body: any
}
AsciiCast =
  Header { version, width, height, title, time }
| Output [ time: number, stream: "i"|"o"|"e", data: string ]
```

### 6.9 SQL 控制台

```
SchemaList   { schemas: string[], default_schema?: string, readonly: bool, kind: "MySql"|"Postgres" }
TableList    { tables: { name, type: string }[] }                                    // Rust kind→"type"
ColumnList   { columns: { name, data_type, nullable, primary_key }[] }
QueryRequest { sql, limit?: i64, console_session_key?: string }
QueryResponse{
  columns: { name, type_name }[], rows: any[][],
  rows_affected: u64 | null, truncated, elapsed_ms: u64, limit: i64,
  statement_kind: "SELECT"|"SHOW"|"EXPLAIN"|"DESCRIBE"|"INSERT"|"UPDATE"|"DELETE"|"CREATE"|"ALTER"|"DROP"|"TRUNCATE"|"OTHER"|"UNKNOWN"
}
ErrorBody    { error: string }                                                       // 所有 DbError 的 body
```

`DbError` 的 HTTP 状态：`400 / 401 / 403 / 404 / 429 / 500 / 502`。`429` 带 `Retry-After` 头。

### 6.10 终端 WebSocket 帧

| Opcode | 方向 | 适用端点 | Payload |
|---|---|---|---|
| `0x00` `MSG_TERMINAL_DATA` | 双向 | ssh / mysql / postgres | 原始字节 |
| `0x01` `MSG_RESIZE` | client → server | ssh (u32) / mysql / postgres (u16) | `{ cols, rows }` |
| `0x02` `MSG_STATUS` | server → client | 全部 | `{ status, message }` |
| `0x03` `MSG_HOST_KEY_VERIFY` | 双向 | 仅 ssh | server → client `{ status:"host_key_verify", algorithm, key_base64 }`；client → server `{ accepted: bool }`，60 s 超时 |

### 6.11 管理面其它

```
LogEntry         { id, text, values: JsonValue, timestamp, session_id, username? }
ParameterValues  { allow_own_credential_management, rate_limit_bytes_per_second?: u32,
                   ssh_client_auth_publickey, ssh_client_auth_password,
                   ssh_client_auth_keyboard_interactive, minimize_password_login,
                   sql_console_rate_limit_per_user?: u32, sql_console_rate_limit_per_target?: u32 }
ParameterUpdate  // 同上，但 ssh_* 与 minimize_password_login 可缺省（保留旧值）
SSHKey           { kind: string, public_key_base64: string }
PaginatedResponse<T> { items: T[], total: u64, offset: u64 }                         // limit 不回显
```

### 6.12 健康检查

```
DeepHealthReport { status: "ok"|"warn"|"fail", generated_at, checks: DeepHealthCheck[] }
DeepHealthCheck  { name: string, status: "ok"|"warn"|"fail", message?: string }
```

Roll-up：任一 `fail` → `fail`；否则任一 `warn` → `warn`；否则 `ok`。

<!-- BEGIN GENERATED OPERATION INDEX: bun run openapi -->

## 7. OpenAPI 操作索引

由 `bun run openapi` 从 Rust 源码导出的 OpenAPI 契约生成，请勿手工编辑；CI 通过 `bun run openapi --check` 校验。请求与响应结构以 `web/scripts/openapi/*.snapshot.json` 为准。

### 用户面 `/api`

| Method | Path | operationId | Summary |
|---|---|---|---|
| DELETE | `/api/auth/state` | `cancel_default_auth` |  |
| DELETE | `/api/profile/api-tokens/:id` | `delete_my_api_token` |  |
| DELETE | `/api/profile/credentials/certificates/:id` | `revoke_my_certificate` |  |
| DELETE | `/api/profile/credentials/otp/:id` | `delete_my_otp` |  |
| DELETE | `/api/profile/credentials/public-keys/:id` | `delete_my_public_key` |  |
| DELETE | `/api/profile/tickets/:id` | `delete_my_ticket` |  |
| GET | `/api/auth/state/:id` | `get_auth_state` |  |
| GET | `/api/auth/state` | `get_default_auth_state` |  |
| GET | `/api/auth/web-auth-requests` | `get_web_auth_requests` |  |
| GET | `/api/db/columns/:target_name` | `get_db_columns` |  |
| GET | `/api/db/schemas/:target_name` | `get_db_schemas` |  |
| GET | `/api/db/tables/:target_name` | `get_db_tables` |  |
| GET | `/api/info` | `get_info` |  |
| GET | `/api/profile/api-tokens` | `get_my_api_tokens` |  |
| GET | `/api/profile/credentials` | `get_my_credentials` |  |
| GET | `/api/profile/sessions` | `get_my_sessions` | Sessions owned by the calling user, newest first. Management HTTP |
| GET | `/api/profile/tickets` | `get_my_tickets` |  |
| GET | `/api/sso/logout` | `initiate_sso_logout` |  |
| GET | `/api/sso/providers/:name/start` | `start_sso` |  |
| GET | `/api/sso/providers` | `get_sso_providers` |  |
| GET | `/api/sso/return` | `return_to_sso` |  |
| GET | `/api/targets` | `get_targets` |  |
| POST | `/api/auth/login` | `login` |  |
| POST | `/api/auth/logout` | `logout` |  |
| POST | `/api/auth/otp` | `otpLogin` |  |
| POST | `/api/auth/state/:id/approve` | `approve_auth` |  |
| POST | `/api/auth/state/:id/reject` | `reject_auth` |  |
| POST | `/api/auth/state/continue` | `continue_default_auth` | Finish a login whose remaining factor was granted out of band (web |
| POST | `/api/db/query/:target_name` | `run_db_query` |  |
| POST | `/api/profile/api-tokens` | `create_api_token` |  |
| POST | `/api/profile/credentials/certificates` | `issue_my_certificate` |  |
| POST | `/api/profile/credentials/otp/begin` | `begin_my_otp` | Start OTP enrollment. The server generates the secret, |
| POST | `/api/profile/credentials/otp` | `add_my_otp` | Confirm OTP enrollment. Requires a live code for the |
| POST | `/api/profile/credentials/password` | `change_my_password` |  |
| POST | `/api/profile/credentials/public-keys` | `add_my_public_key` |  |
| POST | `/api/profile/tickets` | `create_my_ticket` |  |
| POST | `/api/sso/return` | `return_to_sso_with_form_data` |  |

### 管理面 `/admin/api`

| Method | Path | operationId | Summary |
|---|---|---|---|
| DELETE | `/admin/api/accounts/:id` | `delete_account` |  |
| DELETE | `/admin/api/command-acl-rule/:id` | `delete_command_acl_rule` |  |
| DELETE | `/admin/api/management-sessions/:id` | `revoke_management_session` |  |
| DELETE | `/admin/api/role/:id` | `delete_role` |  |
| DELETE | `/admin/api/sessions/:id` | `delete_session` | Delete a session record and everything attached to it: its recording |
| DELETE | `/admin/api/sessions/closed` | `delete_closed_sessions` | Delete all ended (historical) session records and their attached |
| DELETE | `/admin/api/sessions` | `close_all_sessions` | Close every live session. Admin-only — the whole `/admin/api` nest is |
| DELETE | `/admin/api/ssh/known-hosts/:id` | `delete_ssh_known_host` |  |
| DELETE | `/admin/api/target-groups/:id` | `delete_target_group` |  |
| DELETE | `/admin/api/targets/:id/roles/:role_id` | `delete_target_role` |  |
| DELETE | `/admin/api/targets/:id` | `delete_target` |  |
| DELETE | `/admin/api/tickets/:id` | `delete_ticket` |  |
| DELETE | `/admin/api/users/:id/roles/:role_id` | `delete_user_role` |  |
| DELETE | `/admin/api/users/:id` | `delete_user` |  |
| DELETE | `/admin/api/users/:user_id/api-tokens/:id` | `delete_user_api_token` |  |
| DELETE | `/admin/api/users/:user_id/credentials/certificates/:id` | `revoke_certificate_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/otp/:id` | `delete_otp_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/passwords/:id` | `delete_password_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/public-keys/:id` | `delete_public_key_credential` |  |
| DELETE | `/admin/api/users/:user_id/credentials/sso/:id` | `delete_sso_credential` |  |
| GET | `/admin/api/accounts/:id/references` | `get_account_references` |  |
| GET | `/admin/api/accounts/:id` | `get_account` |  |
| GET | `/admin/api/accounts` | `get_accounts` |  |
| GET | `/admin/api/command-acl-rule/:id` | `get_command_acl_rule` |  |
| GET | `/admin/api/command-acl-rules` | `get_command_acl_rules` |  |
| GET | `/admin/api/command-records` | `get_command_records` | List/search command records across the shell and SQL audit streams. |
| GET | `/admin/api/command-reviews` | `get_command_reviews` |  |
| GET | `/admin/api/management-sessions` | `get_management_sessions` |  |
| GET | `/admin/api/parameters` | `get_parameters` |  |
| GET | `/admin/api/recordings/:id/http-proxy` | `get_http_proxy_recording` |  |
| GET | `/admin/api/recordings/:id` | `get_recording` |  |
| GET | `/admin/api/role/:id/targets` | `get_role_targets` |  |
| GET | `/admin/api/role/:id/users` | `get_role_users` |  |
| GET | `/admin/api/role/:id` | `get_role` |  |
| GET | `/admin/api/roles` | `get_roles` |  |
| GET | `/admin/api/sessions/:id/recordings` | `get_session_recordings` |  |
| GET | `/admin/api/sessions/:id` | `get_session` |  |
| GET | `/admin/api/sessions` | `get_sessions` |  |
| GET | `/admin/api/ssh/known-hosts` | `get_ssh_known_hosts` |  |
| GET | `/admin/api/ssh/own-keys` | `get_ssh_own_keys` |  |
| GET | `/admin/api/target-groups/:id` | `get_target_group` |  |
| GET | `/admin/api/target-groups` | `list_target_groups` |  |
| GET | `/admin/api/targets/:id/known-ssh-host-keys` | `get_ssh_target_known_ssh_host_keys` |  |
| GET | `/admin/api/targets/:id/roles` | `get_target_roles` |  |
| GET | `/admin/api/targets/:id` | `get_target` |  |
| GET | `/admin/api/targets` | `get_targets` |  |
| GET | `/admin/api/tickets` | `get_tickets` |  |
| GET | `/admin/api/users/:id/roles` | `get_user_roles` |  |
| GET | `/admin/api/users/:id` | `get_user` |  |
| GET | `/admin/api/users/:user_id/api-tokens` | `get_user_api_tokens` |  |
| GET | `/admin/api/users/:user_id/credentials/certificates` | `get_certificate_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/otp` | `get_otp_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/passwords` | `get_password_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/public-keys` | `get_public_key_credentials` |  |
| GET | `/admin/api/users/:user_id/credentials/sso` | `get_sso_credentials` |  |
| GET | `/admin/api/users` | `get_users` |  |
| PATCH | `/admin/api/users/:user_id/credentials/certificates/:id` | `update_certificate_credential` |  |
| POST | `/admin/api/accounts/:id/reveal` | `reveal_account` |  |
| POST | `/admin/api/accounts` | `create_account` |  |
| POST | `/admin/api/command-acl-rules` | `create_command_acl_rule` |  |
| POST | `/admin/api/command-review/:id/approve` | `approve_command_review` |  |
| POST | `/admin/api/command-review/:id/reject` | `reject_command_review` |  |
| POST | `/admin/api/logs` | `get_logs` |  |
| POST | `/admin/api/management-audit` | `get_management_audit` |  |
| POST | `/admin/api/roles` | `create_role` |  |
| POST | `/admin/api/sessions/:id/close` | `close_session` | Gracefully close a live session: signal its handle so the owning |
| POST | `/admin/api/sessions/:id/terminate` | `terminate_session` | Forcibly terminate a live session. Unlike graceful `close`, which only |
| POST | `/admin/api/ssh/check-host-key` | `check_ssh_host_key` |  |
| POST | `/admin/api/ssh/known-hosts` | `add_ssh_known_host` |  |
| POST | `/admin/api/target-groups` | `create_target_group` |  |
| POST | `/admin/api/targets/:id/roles/:role_id` | `add_target_role` |  |
| POST | `/admin/api/targets` | `create_target` |  |
| POST | `/admin/api/tickets` | `create_ticket` |  |
| POST | `/admin/api/users/:id/roles/:role_id` | `add_user_role` |  |
| POST | `/admin/api/users/:user_id/api-tokens` | `create_user_api_token` |  |
| POST | `/admin/api/users/:user_id/credentials/certificates` | `issue_certificate_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/otp` | `create_otp_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/passwords` | `create_password_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/public-keys` | `create_public_key_credential` |  |
| POST | `/admin/api/users/:user_id/credentials/sso` | `create_sso_credential` |  |
| POST | `/admin/api/users` | `create_user` |  |
| PUT | `/admin/api/accounts/:id` | `update_account` |  |
| PUT | `/admin/api/command-acl-rule/:id` | `update_command_acl_rule` |  |
| PUT | `/admin/api/parameters` | `update_parameters` |  |
| PUT | `/admin/api/role/:id` | `update_role` |  |
| PUT | `/admin/api/target-groups/:id` | `update_target_group` |  |
| PUT | `/admin/api/targets/:id` | `update_target` |  |
| PUT | `/admin/api/users/:id` | `update_user` |  |
| PUT | `/admin/api/users/:user_id/credentials/public-keys/:id` | `update_public_key_credential` |  |
| PUT | `/admin/api/users/:user_id/credentials/sso/:id` | `update_sso_credential` |  |

<!-- END GENERATED OPERATION INDEX -->
