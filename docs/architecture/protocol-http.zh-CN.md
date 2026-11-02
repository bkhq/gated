# HTTP 反向代理（`crates/gated-protocol-http`）

[English](protocol-http.md) | 简体中文

HTTP 代理是一个专用的 HTTPS 监听器，把请求转发到 HTTP 目标。它与 `gated-admin` 中的管理 / 门户 HTTP 服务分开
（见 [management-plane.zh-CN.md](management-plane.zh-CN.md)）；代理监听器**只**做代理，没有 UI 或登录页。

`http` 类型的目标带有 `flavor` 字段（`crates/gated-common/src/config/target.rs`）：`generic` 用于普通 HTTP
服务，`kubernetes` 用于 Kubernetes API 服务器。管理 UI 的目标列表也会显示该变体。

## 监听器

当 `http.enable = true` 时，`run_server`（`crates/gated-protocol-http/src/server.rs`）由 run 命令
（`crates/gated/src/commands/run.rs`）启动。与其他代理不同，它不实现 `ProtocolServer`；它是只有一个兜底路由的
axum 应用。

TLS 终结：

- 证书 / 密钥来自 `http.certificate` / `http.key`（`server.rs`）；
- rustls `ServerConfig` 使用 `build_client_cert_verifier`
  （`crates/gated-protocol-http/src/kubernetes/client_certs.rs`）提供的客户端证书验证器：客户端证书是可选的，
  因此 Bearer 令牌客户端仍能连接，但出示的证书必须链到实例 CA，且握手证明了对其私钥的持有；
- 共享 HTTP 服务（`crates/gated-common/src/web/server.rs`）把验证过的对端证书存入请求扩展 `ConnectionInfo`，
  由请求认证读取。

## 路由：请求到目标

解析分两级（`crates/gated-protocol-http/src/resolver.rs`）：

1. 显式的 `X-Gated-Target: <name>` 头优先（`resolver.rs`）；
2. 否则 `Host` 头必须形如 `<target>.<base_domain>`，其中 `base_domain` 是配置中的 `http.base_domain`。只接受
   恰好多一级 DNS 标签；去掉端口；匹配不区分大小写。

解析失败和未知目标名都返回不带 `WWW-Authenticate` 质询的裸 `401`，刻意不透露目标是否存在。该监听器没有会话
cookie；每个请求独立解析目标。

## 认证与授权

`authenticate_request`（`server.rs`）接受两类凭据：

- **API 令牌** —— `Authorization: Bearer <token>`，或供浏览器直接访问使用的 `?gated-token=<token>` 查询参数
  （记录日志时会从 URL 中抹去），通过 `ConfigProvider::validate_api_token`
  （`crates/gated-core/src/config_providers/db.rs`）校验；
- **mTLS 客户端证书** —— 握手中捕获的证书由 `validate_client_certificate`
  （`crates/gated-protocol-http/src/kubernetes/auth.rs`）检查：先在 `certificate_revocations` 表中查找序列号，
  再与已存储的 `CertificateCredential` 行的序列号匹配，解析出用户并更新 `last_used`。签发见
  [tls-and-ca.zh-CN.md](tls-and-ca.zh-CN.md)。

该监听器没有密码 / SSO 登录，也不支持票据。认证后强制执行 `ConfigProvider::authorize_target`（`server.rs`）。

## 目标连接

`build_http_client`（`crates/gated-protocol-http/src/engine.rs`）为每个目标构建一个 `reqwest` 客户端：

- 从不跟随重定向（`Policy::none()`，`engine.rs`）—— 重定向回传给客户端；
- TLS 验证由目标的 `tls.verify` 标志控制，可选的每目标 `ca_certificate` PEM 证书包被加为根证书；
- 上游认证（`crates/gated-common/src/config/target.rs` 中的 `UpstreamAuth`）作为默认请求头注入：自定义
  `headers`、`bearer_token`，或 mTLS `client_certificate` 身份。

URL 构造（`construct_target_url`，`engine.rs`）把请求路径 / 查询拼接到目标基础 URL；通用变体拒绝 `..` 路径段
（路径穿越防护），而 Kubernetes 变体跳过该检查（API 服务器的某些子资源需要它们，并自行校验）。

请求头处理（`collect_forwarded_headers`，`engine.rs`）：

- 全局剥离列表 `DONT_FORWARD_HEADERS`（`crates/gated-common/src/http_headers.rs`）移除逐跳头和 websocket 协商头；
- 始终移除 `Authorization`、`X-Gated-Target` 和 `X-Gated-Token`；
- 移除会遮蔽已配置上游认证头的请求头；
- 返回时剥离响应的 `content-encoding`/`content-length`/`transfer-encoding`（由服务器重新分帧响应体）。

请求和响应体以 100 MiB 上限缓冲（`API_PROXY_MAX_BODY_SIZE`，`crates/gated-common/src/http_headers.rs`），流式
响应除外（见下文）。

## Kubernetes 变体的特性

| 方面 | 行为 |
|---|---|
| 会话模型 | `RequestCorrelator`（`crates/gated-protocol-http/src/kubernetes/correlator.rs`）把请求按（用户，目标，客户端 IP）关联为一个逻辑会话，每 60 秒清理一次（`correlator.rs`）；通用变体每个请求创建一个会话。 |
| WebSocket | `kubectl exec`/`attach`/`port-forward` 的升级请求被代理，支持 `channel.k8s.io` 和 `v2`-`v5` 变体（`crates/gated-protocol-http/src/kubernetes/websocket.rs`）；上游 websocket 客户端强制使用 HTTP/1.1。 |
| Watch 流式传输 | 分块响应或以 `watch=true` 请求的响应以流式返回而不缓冲（`engine.rs`）。 |
| Accept 头 | 从 `Accept` 中过滤掉 `application/vnd.kubernetes.protobuf`，让响应保持 JSON。 |
| Exec/attach 录制 | 识别 URL 模式 `/api/v1/namespaces/<ns>/pods/<pod>/(exec|attach)`；命名空间、pod、容器和命令作为录制元数据存储，websocket 字节流被解码进 `TerminalRecorder`（stdout/stderr 帧、PTY 尺寸变更帧）（`crates/gated-protocol-http/src/kubernetes/recording.rs`、`websocket.rs`）。 |
| 身份模拟 | 不使用 —— gated 用目标自身的凭据（bearer 令牌、请求头或客户端证书）向 API 服务器认证；不注入 `Impersonate-*` 头。 |

## 录制挂钩

开启录制时，每个代理会话为每个请求记录一条 `HttpProxyRecordingItem` —— 时间戳、方法、路径、转发的请求头、
请求体、响应状态和响应体（流式时为 None）—— 通过录制子系统写入（`crates/gated-protocol-http/src/recording.rs`，
在 `build_downstream_response`（`engine.rs`）中写入）。Kubernetes exec/attach 会话还会如上所述产生终端录制。

无论是否开启录制，每个被代理的请求都会向会话日志写入一条结构化日志（方法、URL、状态、客户端 IP）
（`server.rs`，`log_request_result`；见 [sessions-recordings-audit.zh-CN.md](sessions-recordings-audit.zh-CN.md)）。
