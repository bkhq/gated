# 会话、录制、审计与数据库层

[English](sessions-recordings-audit.md) | 简体中文

## 会话注册表（`crates/gated-core/src/state.rs`）

`State`（`state.rs`）是实时会话的内存注册表：会话 UUID 到 `SessionState`（`state.rs`）的映射，记录远端地址、
已认证用户、所选目标、协议名、会话的限速器句柄，以及一个实现 `SessionHandle`
（`crates/gated-core/src/protocols/handle.rs`）的协议专属句柄，其唯一方法 `close()` 让管理面可以终止连接。

`register_session` 分配 UUID、插入内存条目并增加 `gated_sessions_active` 指标。`Session` 行
（`crates/gated-db-entities/src/Session.rs`）只在用户认证成功时写入（`GatedServerHandle::set_user_info`），
因此登录失败和端口扫描不会留下行；每次登录失败改为写一条 `auth_login_rejected` 审计条目。返回的 guard 在释放
时移除会话：`remove_session` 删除映射条目、减少指标，并设置行的 `ended` 时间戳（`mark_session_complete`）。
广播通道把变化通知订阅者（例如管理 UI 的会话列表）。管理员发起的关闭经过
`crates/gated-admin/src/api/sessions_detail.rs`，对实时条目调用 `session.handle.close()`。

浏览器登录不在这个注册表中；它们使用 [management-plane.zh-CN.md](management-plane.zh-CN.md) 中描述的管理会话
注册表。Web 终端和 Web 文件管理器在这里分别登记为 `WebSSH`、`WebMySQL`、`WebPostgreSQL` 和 `WebSFTP` 会话；
`close()` 会结束终端（状态帧、关闭 WebSocket、断开上游）。配置重新加载后，以及可能撤销访问权限的用户 / 角色 /
目标变更后，实时会话会被重新授权；失去授权的会话会被关闭。

启动时，`populate_db`（`crates/gated-core/src/db/mod.rs`）会关闭上次崩溃遗留的未结束会话 / 录制。

## 录制（`crates/gated-core/src/recordings/`）

`SessionRecordings`（`recordings/mod.rs`）是工厂：`start()`（`mod.rs`）创建一条 `Recording` 数据库行，以及一个
写入 `<recordings.path>/<session_id>/<name>` 文件的带缓冲异步 `RecordingWriter`。写入器每隔几秒刷新一次，广播
追加的字节供实时跟踪（`subscribe_live`，`mod.rs`），并在释放时写入行的 `ended` 时间。

六种类型（`RecordingKind`，`crates/gated-db-entities/src/Recording.rs`）：

| 类型 | 录制器 | 磁盘格式 | 产生者 |
|---|---|---|---|
| `Terminal` | `TerminalRecorder`（`recordings/terminal.rs`） | 带时间戳的输入 / 输出 / 错误数据和 PTY 尺寸变更的 JSON Lines；回放时转换为 asciicast v2 | SSH shell/exec 通道、Kubernetes exec/attach websocket、Web 终端 |
| `Traffic` | `TrafficRecorder`（`recordings/traffic.rs`） | 带合成 TCP 握手的 PCAP | SSH 端口 / socket 转发 |
| `HttpProxy` | HTTP 代理录制器 | JSON Lines，每个请求一条（方法、路径、请求头、请求 / 响应体、状态） | HTTP 反向代理 |
| `SqlAudit` | `StructuredRecorder`（`recordings/structured.rs`） | `SqlAuditRecordingItem::Query` 的 JSON Lines：SQL 文本、语句类型、耗时毫秒、成功、错误 | MySQL/PostgreSQL 代理、Web SQL 控制台 |
| `CommandAudit` | `CommandAuditRecorder`（`structured.rs`） | `ShellCommandRecordingItem` 的 JSON Lines：命令、来源、ACL 判定和结果 | SSH 会话（命令管控） |
| `FileAudit` | `FileAuditRecorder`（`structured.rs`） | `FileAuditRecordingItem` 的 JSON Lines：操作、路径、字节数、成功 | 原生 SFTP、Web 文件管理器 |

回放端点（`crates/gated-admin/src/api/recordings_detail.rs`）：asciicast 导出（`api_get_recording_cast`）、PCAP
下载（`api_get_recording_tcpdump`）、HTTP 交互列表，以及跟踪进行中终端录制的 WebSocket 实时流
（`api_get_recording_stream`）。命令审计和文件审计通过 `/admin/api/command-records` 和
`/admin/api/file-records` 查询。

录制通过 `recordings.enable` 全局开启（默认关闭）。

## 审计日志（`crates/gated-core/src/logging/`）

只持久化显式的审计事件：

- `ValuesLogLayer`（`logging/layer.rs`）持久化以 `target: "audit"` 发出、级别 INFO 及以上的事件，并继承父 span
  中的值（会话 id、用户名、客户端 IP）。其他 tracing 事件只进入控制台 / 文件输出。
- 数据库输出（`logging/database.rs`）把它们插入为 `LogEntry` 行（文本、JSON 值、时间戳、会话 id、用户名），可通过
  `POST /admin/api/logs` 和管理 UI 浏览。
- 管理写操作单独记录在 `management_audit` 表中（见 [management-plane.zh-CN.md](management-plane.zh-CN.md)），
  会话删除和账户凭据明文查看也记录在那里。
- 可选输出：UNIX 数据报 socket（`log.send_to`，`logging/socket.rs`）、滚动文件、JSON 控制台格式和 OTLP 导出器
  （`log` 配置段）。

保留期由 `cleanup_db`（`crates/gated-core/src/db/mod.rs`）执行：清理早于 `log.retention`（默认 7 天）的日志条目、
已结束的录制（行和文件）和已结束的会话，以及早于 `log.management_retention`（默认 7 天）的管理审计行；定时器间隔
为较短保留期的十分之一。

## 数据库层

- **引擎**：SQLite（默认 `sqlite:data/db`；`setup` 在数据目录下写入 `sqlite:db`）、PostgreSQL 和 MySQL，通过
  SeaORM/sqlx 访问（`crates/gated-core/src/db/mod.rs`）。
- **静态加密**：SQLite 可选 SQLCipher（`make_sqlcipher_connect_options`，`db/mod.rs`）；数据加密密钥在启动时通过
  解锁 API 提供，解锁前 `Services.db` 保持为 `None`。`gated encrypt-existing-db` 就地迁移明文数据库。
- **实体**（`crates/gated-db-entities/src/`）：User、Role、UserRoleAssignment、Target、TargetGroup、
  TargetRoleAssignment、TargetAccount、Account、Session、Recording、LogEntry、ManagementAudit、CommandAclRule、
  Ticket、ApiToken、KnownHost、Parameters（含 CA 密钥对）、CertificateRevocation，以及五张凭据表（Password、
  PublicKey、Otp、Sso、Certificate）。
- **迁移**（`crates/gated-db-migrations/src/`）：`m00001_initial` 创建基础结构；`m00002`/`m00003` 刻意为空（其
  结构已包含在 `m00001` 中），`m00004`–`m00012` 添加 OIDC 身份列、对存储的令牌 / 票据密钥做哈希，并创建命令
  ACL、水印、名称唯一性、管理审计、站点标题和按角色文件传输相关结构。迁移在启动时自动执行；随后 `populate_db`
  在缺失时初始化内置 `admin` 角色和 CA 证书。

## 指标（`crates/gated-core/src/metrics.rs`）

设置 `metrics.enable` 时安装 Prometheus 记录器（`install_recorder`，`metrics.rs`），由可观测性监听器输出
（`/metrics`，以及 `/healthz` 和 `/readyz`，`crates/gated/src/commands/run.rs`）。指标族（`metrics.rs`）：

- `gated_sessions_active`（gauge，按协议）
- `gated_auth_attempts_total`（counter，result/method）
- `gated_db_query_total` 和 `gated_db_query_duration_seconds`（SQL 控制台，按目标）
- `gated_rate_limit_rejected_total`
- `gated_config_reload_total`
