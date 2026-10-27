# Gated 代码设计

[English](code-design.md) | 简体中文

主要运行时部件如何协同：共享服务、会话注册表、会话生命周期、管理面与会话面的边界，以及前后端契约。crate 职责、
部署模型和各协议细节见 [../architecture/README.zh-CN.md](../architecture/README.zh-CN.md)。

---

## 1. 关键类型与 trait

### 1.1 `Services` —— 组合根

`Services`（`crates/gated-core/src/services.rs`）是一组以 `Arc` 包装的共享状态，克隆开销很小，交给每个协议服务：

- `db: SharedDatabaseConnection` —— `Arc<RwLock<Option<DatabaseConnection>>>`（`services.rs`）；加密数据库锁定时
  为 `None`。所有数据库使用者都经过 `db_required()`（`services.rs`），失败时返回 `DbLockedError`（通过其
  `IntoResponse` 实现映射为 HTTP 423）。
- `recordings: Arc<Mutex<SessionRecordings>>` —— 录制管理器。
- `config: Arc<RwLock<GatedConfig>>` —— 实时配置（支持热加载）。
- `state: Arc<RwLock<State>>` —— 内存会话注册表。
- `config_provider: Arc<Mutex<ConfigProviderEnum>>` —— 用户 / 目标 / 凭据查询（1.4 节）。
- `auth_state_store: Arc<Mutex<AuthStateStore>>` —— 进行中的认证状态机。
- `admin_token: Arc<ArcSwapOption<String>>` —— 可选的静态管理 API 令牌。
- `rate_limiter_registry`、`sql_console_rate_limiter`、`db_pool_registry` —— 限速和 SQL 控制台连接池缓存。
- `metrics: Option<Arc<MetricsHandle>>`、`global_params`，以及用于静态加密解锁流程的 `encryption_runtime` /
  `encryption_bootstrap_token` / `encryption_notify`。

`Services::new`（`services.rs`）构建上述全部内容，启动一个 60 秒周期的 `AuthStateStore::vacuum` 循环
（`services.rs`），并构造 `State`。数据库稍后由 `open_db_legacy()` / `open_db(dek_hex)`（`services.rs`）打开。

### 1.2 `State`、`SessionState` 与会话句柄

`State`（`crates/gated-core/src/state.rs`）是内存会话注册表：

```rust
pub struct State {
    pub sessions: HashMap<SessionId, Arc<Mutex<SessionState>>>,
    db: SharedDatabaseConnection,
    rate_limiter_registry: Arc<Mutex<RateLimiterRegistry>>,
    change_sender: broadcast::Sender<()>,
}
```

`State::register_session(this, protocol, SessionStateInit)` 是创建任何类型会话的唯一入口。它生成 UUID，把
`SessionState` 插入映射，增加 `gated_sessions_active` 指标，广播变更通知，并返回
`Arc<Mutex<GatedServerHandle>>`。它不访问数据库：`Session` 行在用户认证成功时插入（2.1 节）。

`SessionState`（`state.rs`）包含 `remote_address`、`user_info: Option<AuthStateUserInfo>`、`target: Option<Target>`、
协议专属的 `handle: Box<dyn SessionHandle>`、限速器句柄以及保存的协议名。`SessionStateInit`（`state.rs`）是调用者
提供的内容：远端地址和句柄。

句柄分两层：

- `SessionHandle`（`crates/gated-core/src/protocols/handle.rs`）是协议侧的最小契约：`fn close(&mut self)`。每个
  协议提供自己的实现（例如 `SSHSessionHandle` 通过通道发送 `Close` 命令，
  `crates/gated-protocol-ssh/src/server/session_handle.rs`；Web 终端共用 `TerminalSessionHandle`，它唤醒终端桥接；
  通用 HTTP 的 `ApiSessionHandle` 什么也不做）。
- `GatedServerHandle`（`handle.rs`）是 `register_session` 返回的核心侧句柄。`set_user_info` 首次调用时插入
  `Session` 行，之后更新 `username`；`set_target` 更新内存中的目标，并在行存在后更新其 `target_snapshot`。两者
  都会刷新限速器。`wrap_stream` 在客户端流上叠加字节速率限速器。其 `Drop` 实现会启动
  `State::remove_session(id)`，使句柄释放成为通用的会话终止路径。

`SessionSnapshot`（`crates/gated-core/src/data.rs`）是管理 API 返回的 `Session` 行的可序列化投影。

### 1.3 协议服务抽象

```rust
// crates/gated-core/src/protocols/mod.rs
pub trait ProtocolServer {
    fn name(&self) -> &'static str;
    fn run(self, address: ListenEndpoint) -> impl Future<Output = Result<()>> + Send;
}
```

实现：

| 服务 | Crate / 定义 | 监听配置 |
|---|---|---|
| `HTTPProtocolServer`（管理 + 用户门户） | `crates/gated-admin/src/http_service/mod.rs` | `store.admin.listen` |
| `SSHProtocolServer` | `crates/gated-protocol-ssh/src/lib.rs` | `store.ssh.listen` |
| `MySQLProtocolServer` | `crates/gated-protocol-mysql/src/lib.rs` | `store.mysql.listen` |
| `PostgresProtocolServer` | `crates/gated-protocol-postgres/src/lib.rs` | `store.postgres.listen` |

HTTP 反向代理监听器是例外：它是自由函数 `gated_protocol_http::server::run_server`（`server.rs`），而不是
`ProtocolServer` 实现，由 `crates/gated/src/commands/run.rs` 放入同一个 future 集合。

### 1.4 `ConfigProvider`

`ConfigProvider`（`crates/gated-core/src/config_providers/mod.rs`）抽象用户 / 目标 / 凭据查询：`list_users`、
`list_targets`、`validate_credential`、`username_for_sso_credential`、`apply_sso_role_mappings`、
`get_credential_policy`、`authorize_target`、`update_public_key_last_used`、`validate_api_token`。它通过
`enum_dispatch` 经由 `ConfigProviderEnum`（`mod.rs`）分发，目前唯一的变体是 `DatabaseConfigProvider`
（`crates/gated-core/src/config_providers/db.rs`）—— 所有用户、角色、目标和凭据都在数据库中。同一模块还提供票据
校验 / 消费辅助函数 `authorize_ticket`（`mod.rs`）和 `consume_ticket`（`mod.rs`）。

### 1.5 认证状态与事件 / 通知机制

`AuthStateStore`（`crates/gated-core/src/auth_state_store.rs`）把认证状态 UUID 映射到
`Arc<Mutex<AuthState>>` 加时间戳，`vacuum()`（`auth_state_store.rs`）清除过期条目。`AuthState`（在
`gated-common/src/auth/` 中）是每次登录的状态机：用户的 `CredentialPolicy` 决定还需要哪些凭据类型；协议不断送入
凭据，直到它返回接受。

系统中的通知通道：

- **会话变更**：`State.change_sender`（`state.rs`），一个 `broadcast::Sender<()>`，在登记（`state.rs`）、移除
  （`state.rs`）以及 `SessionState::emit_change`（`state.rs`，由 `set_user_info` / `set_target` 触发）时发出。管理
  API 把它暴露为 WebSocket `/admin/api/sessions/changes`（`crates/gated-admin/src/api/sessions_list.rs`），每个事件
  发送一个空文本帧；UI 每收到一帧就重新获取。
- **网页认证请求**：`AuthStateStore.web_auth_request_signal`（`auth_state_store.rs`），一个
  `broadcast::Sender<Uuid>`，在认证状态开始等待浏览器批准时发出（`auth_state_store.rs`）；通过
  `/api/auth/web-auth-requests/stream`（`crates/gated-admin/src/http_service/mod.rs`）提供给 UI。
- **日志管线**：全局 `broadcast::Sender<LogEntry::ActiveModel>`（`crates/gated-core/src/logging/database.rs`）把
  tracing 与数据库写入解耦（2.4 节）。
- **加密解锁**：`Services.encryption_notify`（`services.rs`）在运维人员解锁数据库时唤醒启动循环（`run.rs`）。
- **通用事件中心**：`EventHub` / `EventSender`（`crates/gated-common/src/eventhub.rs`）—— 带过滤的发布 / 订阅，
  SSH 服务端会话用它分发事件（`crates/gated-protocol-ssh/src/server/session.rs`）。
- **实时录制流**：`SessionRecordings.live` 中每个录制一个 `broadcast::Sender<Bytes>`
  （`crates/gated-core/src/recordings/mod.rs` 中的 `subscribe_live`），供管理端录制流端点使用。

### 1.6 数据库实体模型与协议持久化

三个实体承载会话面的全部活动：

**`Session`**（`crates/gated-db-entities/src/Session.rs`），表 `sessions`：`id: Uuid`（主键）、
`target_snapshot: Option<String>`（连接时 `Target` 的 JSON 副本）、`username: Option<String>`、
`remote_address: String`、`started`、`ended: Option<DateTime>`、`ticket_id: Option<Uuid>`、`protocol: String`。
所有协议的所有会话共用一张表 —— 包括 Web UI 自身创建的会话（第 3 节）。

**`Recording`**（`crates/gated-db-entities/src/Recording.rs`），表 `recordings`：`id`、`name`、`started`、`ended`、
`session_id`（指向 `sessions` 的外键，级联删除）、`kind: RecordingKind`
（`Terminal | Traffic | HttpProxy | SqlAudit | CommandAudit | FileAudit`）以及 JSON `metadata`。行只是索引；字节
数据保存在磁盘上的 `<recordings.path>/<session_id>/<name>`（`crates/gated-core/src/recordings/mod.rs`）。

**`LogEntry`**（`crates/gated-db-entities/src/LogEntry.rs`），表 `log`：`id`、`text`、`values: JsonValue`、
`timestamp`、`session_id: Uuid`、`username: Option<String>`。没有外键关系；`session_id` 是普通列。

协议如何持久化数据：

- **录制**：协议调用 `SessionRecordings::start::<T: Recorder, _>(session_id, name, metadata)`
  （`recordings/mod.rs`），它插入 `Recording` 行（`mod.rs`），并返回一个封装 `RecordingWriter`
  （`recordings/writer.rs`）的类型化录制器（`TerminalRecorder`、`TrafficRecorder` 或 `StructuredRecorder`）。写入器
  通过带缓冲的后台任务流式写入磁盘文件，并把字节同步给实时订阅者；释放时写入行的 `ended`。
- **日志条目**：协议只需在会话 span 内发出 `tracing` 事件。`make_database_logger_layer`（`logging/database.rs`）
  安装的 `ValuesLogLayer` 提取 span 字段 `session` 和 `session_username`（`database.rs`）；没有可解析 `session`
  字段的事件会被丢弃，因此只有会话范围内的活动会进入 `log` 表。`install_database_logger`（`database.rs`）安装的
  后台任务负责插入这些行。
- **会话行**：只通过 `GatedServerHandle::set_user_info` / `set_target` 和 `State::mark_session_complete` 写入
  （第 2 节）。

---

## 2. 会话生命周期全过程

### 2.1 创建与登记

每个代理会话和 Web 终端都经过 `State::register_session`（`crates/gated-core/src/state.rs`）。调用点：

| 来源 | 调用点 | 协议字符串 | 句柄类型 | 远端地址 |
|---|---|---|---|---|
| SSH 连接 | `crates/gated-protocol-ssh/src/server/mod.rs` | `"SSH"` | `SSHSessionHandle` | 对端地址 |
| MySQL 连接 | `crates/gated-protocol-mysql/src/lib.rs` | `"MySQL"` | `MySqlSessionHandle` | 对端地址 |
| Postgres 连接 | `crates/gated-protocol-postgres/src/lib.rs` | `"PostgreSQL"` | `PostgresSessionHandle` | 对端地址 |
| HTTP 代理，通用变体（每个请求） | `crates/gated-protocol-http/src/server.rs` | `"Http"` | `ApiSessionHandle` | 客户端 IP |
| HTTP 代理，Kubernetes 变体（关联） | `crates/gated-protocol-http/src/kubernetes/correlator.rs` | `"Http"` | `KubernetesSessionHandle` | 客户端 IP |
| Web SSH 终端 | `crates/gated-admin/src/http_service/api/ssh_terminal.rs` | `"WebSSH"` | `TerminalSessionHandle` | `None` |
| Web 数据库终端 | `crates/gated-admin/src/http_service/api/db_terminal.rs` | `"WebMySQL"` / `"WebPostgreSQL"` | `TerminalSessionHandle` | `None` |
| Web 文件管理器 | `crates/gated-admin/src/http_service/api/sftp.rs` | `"WebSFTP"` | `TerminalSessionHandle` | `None` |

浏览器登录不在这里登记；它们在管理会话注册表中（3.1 节）。

Kubernetes 关联器以 `(username, target_name, client_ip)`（`correlator.rs`）为键缓存句柄，让一串 kubectl 请求共享
一个逻辑会话；通用变体的 HTTP 代理每个请求创建一个会话。

登记只创建内存条目。`Session` 行由第一次 `set_user_info` 插入，也就是认证成功时，带上 `started`、
`remote_address`、`protocol`、`username` 以及已选定的目标；`set_target` 之后补上 `target_snapshot`。从未认证成功的
连接不留下行；协议改为写入一条 `auth_login_rejected` 审计条目，`mark_session_complete` 会跳过没有行的会话。

### 2.2 认证

协议通过 `AuthStateStore::create(session_id, username, protocol, supported_credential_types)`
（`crates/gated-core/src/auth_state_store.rs`）创建 `AuthState`，它通过 `ConfigProvider` 查找用户并附上用户的
`CredentialPolicy`。SSH 服务在第一次认证尝试时才延迟执行这一步（`crates/gated-protocol-ssh/src/server/session.rs`）。
凭据通过 `ConfigProvider::validate_credential` 验证；当 `AuthState` 报告接受时协议继续（SSH 接受认证，让用户选择或
自动选择目标；数据库代理用存储的目标凭据连接目标）。`WebUserApproval` 凭据类型会挂起状态机，直到管理员 / 用户在
浏览器中批准请求（1.5 节的网页认证请求信号）。Web 登录通过 `get_auth_state_for_request`
（`crates/gated-admin/src/http_service/common.rs`）使用同一个存储，认证状态 ID 保存在 cookie 会话中。

基于票据的访问绕过交互式认证：`authorize_ticket` / `consume_ticket`（`crates/gated-core/src/config_providers/mod.rs`）
把票据密钥解析为用户 + 固定目标，会话行记录 `ticket_id`。

### 2.3 开始录制

当协议有内容需要录制时开始录制：

- SSH 终端通道：`start_terminal_recording`（`crates/gated-protocol-ssh/src/server/session.rs`）启动
  `TerminalRecorder`；端口转发通道用 `TrafficRecorder` 记录原始流量。
- MySQL/Postgres 代理：每条查询一个 `StructuredRecorder` SQL 审计条目（`crates/gated-protocol-mysql/src/session.rs`）。
- HTTP 代理：通过 `crates/gated-protocol-http/src/recording.rs` 记录请求 / 响应。
- 管理端 Web 终端：在 `ssh_terminal.rs` 和 `db_terminal.rs` 中启动 `TerminalRecorder`。

所有路径都经过 `SessionRecordings::start`（`crates/gated-core/src/recordings/mod.rs`），它写入 `Recording` 行并创建
磁盘文件。如果录制被关闭，调用返回 `Error::Disabled`，协议在不录制的情况下继续。

### 2.4 活动日志

在会话 span 内用 `tracing` 记录的任何内容（span 带 `session` 和 `session_username` 字段；见
`crates/gated-admin/src/http_service/mod.rs` 中 `span_for_request` 的用法以及 SSH 会话的日志 span）都会被数据库日志层
捕获，并异步插入 `log` 表（`crates/gated-core/src/logging/database.rs`）。这在各协议间统一覆盖了认证尝试、目标选择、
通道打开、查询日志和 HTTP 请求结果。

### 2.5 关闭路径

终止统一经过 `GatedServerHandle::Drop`（`crates/gated-core/src/protocols/handle.rs`）→
`State::remove_session`（`state.rs`）→ 移除映射、减少指标、广播变更，以及设置 `Session.ended` 时间戳的
`mark_session_complete`（`state.rs`）。

1. **客户端断开。** 以 SSH 为例：会话事件循环把 `RCEvent::Done` 或 `ServerHandlerEvent::Disconnect` 转换为
   `GatedError::SessionEnd`（`crates/gated-protocol-ssh/src/server/session.rs`）；会话 future 结束，
   `GatedServerHandle` 被释放，行获得 `ended` 时间戳。MySQL/Postgres 会话在其 `run()` future 返回时以同样方式结束
   （`crates/gated-protocol-mysql/src/lib.rs`）。通用 HTTP 的每请求会话在请求结束时释放。

2. **管理员发起关闭。** `POST /admin/api/sessions/:id/close`（`crates/gated-admin/src/api/sessions_detail.rs`）和
   `DELETE /admin/api/sessions`（`crates/gated-admin/src/api/sessions_list.rs`）在 `State.sessions` 中查找会话并调用
   `SessionState.handle.close()`（`sessions_detail.rs`、`sessions_list.rs`）。之后的行为因协议而异：SSH 句柄发送
   `SessionHandleCommand::Close`，会话循环随之发出 "Session closed by admin" 并断开两端
   （`crates/gated-protocol-ssh/src/server/session.rs`）；MySQL 接受任务通过其 `abort_rx` 通道中止
   （`crates/gated-protocol-mysql/src/lib.rs`）；Web 终端的 `TerminalSessionHandle`（`http_service/api/common.rs`）
   通知桥接，桥接发送 `closed` 状态帧、关闭 WebSocket，并断开 SSH 客户端或结束数据库 CLI 进程。HTTP 代理句柄什么也
   不做：每个被代理的请求都单独授权，Kubernetes 会话随关联器过期而结束。

3. **过期 / 超时。**
   - SSH 空闲：`store.ssh.inactivity_timeout` 传入 russh 服务端配置（`crates/gated-protocol-ssh/src/server/mod.rs`）；
     russh 断开连接，进入路径 1。
   - Kubernetes HTTP 会话：60 秒周期的清理任务丢弃早于 `store.http.session_max_age` 的关联器句柄
     （`crates/gated-protocol-http/src/kubernetes/correlator.rs`）；释放缓存的 `GatedServerHandle` 即关闭会话。
   - Web（cookie）会话：`SessionStore::vacuum` 丢弃空闲超过 `store.admin.session_max_age` 的管理会话句柄
     （`crates/gated-admin/src/http_service/session.rs`），由 60 秒周期的循环驱动
     （`crates/gated-admin/src/http_service/mod.rs`）。

4. **授权被撤销。** `watch_config_and_reload`（`crates/gated/src/commands/run.rs`）在配置文件重新加载后，以及管理 API
   发出 `authorization_changed` 信号时（删除用户、角色或目标，或移除用户-角色、目标-角色绑定），运行
   `Services::revalidate_sessions`。每个实时会话都用 `authorize_target` 重新检查；未授权的会话被 `handle.close()`。
   检查失败会记录日志，并保留该会话。

---

## 3. 当前管理面与会话面的边界

有两个职责截然不同的 HTTP 监听器：

- **管理 / Web 监听器**（`store.admin.listen`）：`gated_admin::HTTPProtocolServer` 提供管理 API（`/admin/api`）、
  用户 API（`/api`）、内嵌 SPA（`/ui`）、Web 终端，以及把其余请求重定向到 SPA 的兜底路由
  （`crates/gated-admin/src/http_service/catchall.rs`）。
- **代理监听器**（`store.http.listen`）：`gated_protocol_http::server::run_server` 只处理 HTTP 反向代理目标，用
  Bearer 令牌、`?gated-token=` 或 mTLS 客户端证书认证 —— 从不使用 cookie。

### 3.1 浏览器会话使用独立的注册表

管理员 / 用户的 Web 认证基于 cookie：`SessionLayer` 中间件（cookie `gated-http-session`，内存存储）在 `auth` 键下
保存 `SessionAuthorization`（`User(username)` 或 `Ticket {..}`）。登录成功会调用 `authorize_session` →
`SessionStore::create_handle_for`（`crates/gated-admin/src/http_service/session.rs`），在管理注册表中创建
`ManagementSessionHandle`（`session_handle.rs`）。它不创建 `sessions` 行，也不创建 `State.sessions` 条目，因此浏览器
登录不出现在代理会话列表中，没有录制，也不受关闭代理会话的影响。

管理会话在登出、空闲过期（`SessionStore::vacuum`）或修改密码撤销该用户的其他会话
（`SessionStore::revoke_other_sessions`）时结束。cookie 指向已移除句柄的请求，其 HTTP 会话会在
`SessionStore::process_request` 中被清除。注册表只在内存中，因此重启会结束所有浏览器会话。管理员通过
`GET /admin/api/management-sessions` 和 `DELETE /admin/api/management-sessions/:id` 列出和撤销它们。

会话列表端点仍然排除 `protocol = "ManagementHTTP"`。

### 3.2 Web 终端是代理会话

浏览器内的 SSH 终端（`/api/ssh/terminal/:target_name`）和数据库终端（`/api/{mysql,postgres}/terminal/:target_name`）
挂载在管理监听器上，但通过 `State::register_session` 以协议 `WebSSH`、`WebMySQL` 和 `WebPostgreSQL` 登记完整的会话，
在句柄上设置用户 / 目标，并启动 `TerminalRecorder` 录制。与原生代理会话的区别：`remote_address` 为 `None`，SSH 终端
复用 `gated-protocol-ssh` 的 SSH 客户端，数据库终端启动本地 CLI 客户端进程，关闭会话即结束终端（2.5 节）。在
WebSocket 升级之前会检查每用户并发终端上限（`MAX_SESSIONS_PER_USER`）。

### 3.3 共享的内存注册表

- `State.sessions` 由管理 API 读取以关闭会话，并被订阅用于实时更新 WebSocket；每个协议服务和 Web 终端都会写入它。
- `AuthStateStore` 在协议和 Web UI 之间共享：等待 `WebUserApproval` 的 SSH 登录，通过操作同一存储的 `/api/auth/...`
  端点在浏览器中批准，两者由 `web_auth_request_signal` 广播连接（`crates/gated-core/src/auth_state_store.rs`）。浏览器
  登录的认证状态机也在这个存储中运行。
- `Services` 本身（配置、配置提供者、录制、限速器、数据库句柄）是两个面共享的同一个对象。

### 3.4 审计存储

- **`management_audit`**：可识别操作者在 `/admin/api/`、`/api/profile/` 和 `/api/auth/` 下的管理写操作，由
  `audit_request` 中间件（`crates/gated-admin/src/http_service/management_audit.rs`）记录两次：处理器运行前一条
  `requested`，之后一条带响应状态的 `completed`。会话 / 录制删除（`session.delete`）和账户凭据明文查看
  （`account.credentials.reveal`，含操作者、理由和确认因素）也记录在这里。通过 `POST /admin/api/management-audit`
  查询；按 `log.management_retention` 清理。
- **`log`**：来自 tracing 管线的会话范围事件（`crates/gated-core/src/logging/database.rs`），通过
  `POST /admin/api/logs` 查询，按会话日志保留期清理。
- **`sessions`** / **`recordings`**：只包含代理会话和 Web 终端。

简而言之：浏览器认证和管理审计已与会话面分离；Web 终端、`AuthStateStore` 和 `Services` 仍然共享。

---

## 4. 前后端契约

### 4.1 API 面与类型生成

后端暴露两份 OpenAPI 文档，都由 utoipa 生成：

- 管理 API：`/admin/api/openapi.json`（`crates/gated-admin/src/lib.rs`），由 `require_auth` 和 `require_admin`
  （`crates/gated-admin/src/http_service/mod.rs`）把守 —— cookie 会话或 `X-Gated-Token` 头，加上内置管理员角色
  （`http_service/common.rs`）。
- 用户 API：`/api/openapi.json`（`http_service/mod.rs`）。

前端**不**生成客户端代码；它用 `openapi-typescript` 生成 TypeScript *类型*（`web/scripts/generate-openapi-types.ts`，
通过 `bun run openapi` 运行）：`/admin/api/openapi.json` → `web/src/shared/lib/api/admin.types.ts`，
`/api/openapi.json` → `web/src/shared/lib/api/user.types.ts`；规范从 Rust 源码导出，`web/scripts/openapi/` 下已提交的
快照在 CI 中用 `bun run openapi --check` 校验。手写的轻量客户端 `web/src/shared/lib/api/http.ts`（`userApi` → `/api`，
`adminApi` → `/admin/api`，携带 cookie 凭据，全局 `onUnauthorized` 钩子）被功能级的 TanStack Query hook 封装。

后端的请求授权由 `inject_request_authorization`（`crates/gated-admin/src/http_service/common.rs`）在每个请求中注入
一次：cookie 会话（带 cookie 域 / 主机校验）→ 作为静态管理令牌的 `X-Gated-Token` → 作为每用户 API 令牌的
`X-Gated-Token`。

### 4.2 资源嵌入

`web/` 是 React 19 + TypeScript + Vite 应用（TanStack Router/Query、Tailwind、终端用 xterm.js、录制回放用
asciinema-player；见 `web/package.json`）。`vite build` 输出 `web/dist`，由 `gated-web` crate 在编译时通过
`rust-embed` 嵌入（`crates/gated-web/src/lib.rs`）。`spa_endpoint`（`crates/gated-admin/src/http_service/spa.rs`）在
`/ui` 提供嵌入的文件，对带哈希的资源做缓存，并对客户端路由回退到 `index.html`。路由器使用以 `/ui` 为 basepath 的
browser history，因此深链接通过该回退解析。

### 4.3 WebSocket 端点

| 端点 | 后端 | 前端使用方 | 载荷 |
|---|---|---|---|
| `/admin/api/sessions/changes` | `crates/gated-admin/src/api/sessions_list.rs`（挂载于 `src/lib.rs`） | `web/src/features/sessions/hooks/use-sessions-stream.ts` | 每次变更一个空文本帧；客户端使其查询缓存失效 |
| `/api/auth/web-auth-requests/stream` | `crates/gated-admin/src/http_service/api/auth.rs`（挂载于 `http_service/mod.rs`） | `web/src/features/auth-requests/` | 待处理网页认证请求通知 |
| `/api/ssh/terminal/:target_name` | `http_service/api/ssh_terminal.rs` | `web/src/features/terminal/` | 二进制帧，首字节为类型：`0x00` 数据、`0x01` 尺寸 JSON、`0x02` 状态 JSON、`0x03` 主机密钥验证（`ssh_terminal.rs`） |
| `/api/mysql/terminal/:t`、`/api/postgres/terminal/:t` | `http_service/api/db_terminal.rs` | 同一终端功能 | 相同分帧，基于 PTY 的 CLI 客户端 |

共享的自动重连 WebSocket hook（`web/src/shared/hooks/use-websocket.ts`）处理协议切换（ws/wss）、指数退避和可插拔
解码。

录制回放的下载是普通 HTTP（`/admin/api/recordings/:id/cast` 和 `/tcpdump`）；跟踪进行中的终端录制使用 WebSocket
`/admin/api/recordings/:id/stream`（`crates/gated-admin/src/lib.rs`）。
