# 数据库协议代理（MySQL 与 PostgreSQL）

[English](protocol-database.md) | 简体中文

两个数据库代理都以原生线协议与客户端通信，用 gated 的凭据库认证用户，然后使用目标配置中的凭据向真实服务器
建立第二条原生协议连接。握手完成后，流量逐包转发，并解析出查询包用于 SQL 审计录制。

## MySQL 代理（`crates/gated-protocol-mysql`）

### 监听器

`MySQLProtocolServer`（`crates/gated-protocol-mysql/src/lib.rs`）实现 `ProtocolServer`（`lib.rs`）。它从
`mysql.certificate`/`mysql.key` 加载监听器 TLS 证书，以 `TCP_NODELAY` 接受 TCP 连接，每个连接运行一个 `Session`。

**客户端必须使用 TLS。** 代理在握手中声明 `SSL` 能力（`crates/gated-protocol-mysql/src/session.rs`），如果
客户端不请求 TLS 升级，就以错误 1002 "Gated requires TLS" 拒绝连接（`session.rs`）。客户端的 `SSL_REQUEST`
包会触发对封装流的 rustls 升级，之后握手在加密通道中继续。

### 客户端认证握手

- 初始握手提供 `mysql_native_password`；得知用户名后，代理把客户端切换到 `mysql_clear_password`，以获得实际
  密码（连接已经是 TLS，因此是安全的）。
- 用户名使用与 SSH 相同的 `user#target` / `user:target` 语法编码目标，`ticket-<secret>` 选择票据认证
  （`crates/gated-common/src/auth/selector.rs`）。
- 密码通过 `ConfigProvider::validate_credential` 校验，然后应用凭据策略和 `authorize_target`；票据走
  `authorize_ticket`/`consume_ticket`（`crates/gated-core/src/config_providers/mod.rs`）。

### 目标连接

`crates/gated-protocol-mysql/src/client.rs` 使用 `TargetMySqlOptions` 中的凭据连接；如果目标绑定了账户，则
通过 `resolve_db_account`（`crates/gated-core/src/account_credentials.rs`）解析，并覆盖内联的用户名 / 密码。
出站 TLS 遵循目标的 `tls.mode` —— `disabled`、`preferred`（回退到明文）或 `required`（`client.rs`）—— 证书
验证由 `tls.verify` 控制。支持的上游认证插件包括 `mysql_native_password`、`caching_sha2_password`（完整 RSA
流程）、`sha256_password` 和 `mysql_clear_password`。

### 流模型与录制

数据包用 `mysql_common` 的 `PacketCodec` 分帧，封装在基于 `MaybeTlsStream` 的通用 `MySqlStream` 中。转发是
*解析但透明*的：`COM_QUERY` 包被解码以获取 SQL 文本并分类语句类型；检查响应头（OK/ERR/EOF）以计时并捕获错误
信息；其他命令原样透传（`session.rs`）。

每条查询通过 `StructuredRecorder`（`structured.rs`）写为一条 `SqlAuditRecordingItem::Query`
（`crates/gated-core/src/recordings/structured.rs`），包含时间戳、目标、数据库、SQL 文本、语句类型、耗时毫秒数、
成功标志和错误信息；会话元数据为 `SqlAuditSessionMetadata::MySqlProxySession`。

## PostgreSQL 代理（`crates/gated-protocol-postgres`）

### 监听器

`PostgresProtocolServer`（`crates/gated-protocol-postgres/src/lib.rs`）实现 `ProtocolServer`（`lib.rs`）。它
在接受的 socket 上设置 TCP keepalive 和 `TCP_NODELAY`。面向客户端的 TLS 是**协商的，而非强制**：如果客户端
以 `SSLRequest` 开始，代理回复 `Accept` 并升级；否则启动过程以明文继续（`src/session.rs`）。

### 客户端认证握手

- 用户名（使用相同的 `user#target` / `ticket-` 选择器语法）来自启动消息的 `user` 参数。
- 代理向客户端请求 `CleartextPassword` 做密码检查；通过把用户引导到浏览器支持网页批准作为第二因素，与 SSH
  流程一致。
- 校验、策略、目标授权和票据与 MySQL 走相同的核心路径。

### 目标连接

`crates/gated-protocol-postgres/src/client.rs` 按服务器要求的方式向上游认证：明文密码、MD5 或 SASL（通过
`rsasl` crate 实现 SCRAM）。出站 TLS 遵循 `tls.mode`（`client.rs`），由 `tls.verify` 控制证书检查。绑定账户
用同一个 `resolve_db_account` 辅助函数解析。

### 流模型与录制

消息通过 `pgwire` crate 在自定义的 `PostgresStream`（同样基于 `MaybeTlsStream`）上编解码。转发会解析扩展查询
协议：`Parse` 缓存预处理 SQL，`Bind` 把 portal 映射到语句，`Execute`/`Query` 开始一条待定的审计记录，
`CommandComplete`/`ErrorResponse` 以成功或错误详情结束它；其他消息原样转发（`src/session.rs`）。每目标的空闲
超时（默认 10 分钟）会断开不活跃的会话。

审计条目同样是通过 `StructuredRecorder` 写入的 `SqlAuditRecordingItem::Query`，元数据为
`SqlAuditSessionMetadata::PostgresProxySession`。

## 共享 crate：`gated-database-protocols`

从 sqlx-core 的 MySQL 线协议层提取而来，为会话的服务端实现了 `Encode`/`Decode`：能力标志、握手 / 认证切换包、
OK/ERR/EOF 响应、文本协议查询包以及通用缓冲区 trait（`crates/gated-database-protocols/src`）。MySQL 代理使用
这些类型；PostgreSQL 代理改用 `pgwire`，不使用此 crate。TLS 辅助位于 `gated-tls`，不在这里。

## 对比摘要

| 方面 | MySQL | PostgreSQL |
|---|---|---|
| 客户端 TLS | 必需（否则拒绝） | 可选（协商） |
| 客户端认证 | native-password 握手，然后在 TLS 内用 clear-password | CleartextPassword；支持网页批准 |
| 目标选择 | `user#target` / `user:target` / `ticket-` | 相同 |
| 上游认证 | native、caching_sha2、sha256、clear | cleartext、MD5、SASL/SCRAM |
| 上游 TLS | disabled / preferred / required + verify 标志 | 相同 |
| 编解码 | `mysql_common` PacketCodec + `gated-database-protocols` 类型 | `pgwire` |
| 录制 | 逐查询 SQL 审计（StructuredRecorder） | 逐查询 SQL 审计，解析预处理语句 |
