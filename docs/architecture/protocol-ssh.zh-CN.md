# SSH 协议代理（`crates/gated-protocol-ssh`）

[English](protocol-ssh.md) | 简体中文

SSH 代理基于 `russh` crate 构建，对客户端充当完整的 SSH 服务端，对目标充当完整的 SSH 客户端。两条连接之间的
通道一一桥接。

## 监听器

`SSHProtocolServer`（`crates/gated-protocol-ssh/src/lib.rs`）实现 `ProtocolServer` trait（`lib.rs`）；其
`run()` 委托给 `run_server()`（`crates/gated-protocol-ssh/src/server/mod.rs`），后者：

- 启动时通过 `generate_keys()` / `load_keys()`（`crates/gated-protocol-ssh/src/keys.rs`）生成或加载两组密钥：
  **主机密钥**（向入站客户端出示）和**客户端密钥**（用于向目标认证），各有 Ed25519 和 RSA 两种，以 PEM 形式
  存放在配置的 `ssh.keys` 目录下（默认 `data/keys`）；
- 接受 TCP 连接，并为每个连接启动一个任务：先在核心注册表中登记会话（`State::register_session`），再运行
  russh 服务端状态机（`russh::server::run_stream`）；
- 为 russh 配置首选主机密钥算法（Ed25519 优先，其次 RSA-SHA2）、认证失败后的 1 秒延迟、
  `ssh.inactivity_timeout`（默认 5 分钟）以及可选的 `ssh.keepalive_interval`（`server/mod.rs`，构造 russh
  `Config` 处）。

## 入站认证

### 通过用户名选择目标

SSH 用户名同时编码身份和目标，由 `AuthSelector`（`crates/gated-common/src/auth/selector.rs`）解析：

- `ticket-<secret>` 选择票据认证（前缀常量在 `crates/gated-common/src/consts.rs`）；
- 否则用户名按 `#` 或 `:` 拆分为 `username` + `target_name`，例如 `ssh alice:prod-box@gated -p 2222`。

### 认证方式

声明的认证方式由数据库中存储的参数（`ssh_client_auth_publickey`、`ssh_client_auth_password`、
`ssh_client_auth_keyboard_interactive`）决定，并映射到核心凭据系统（`crates/gated-protocol-ssh/src/server/mod.rs`）：

- **公钥** —— 提供的公钥与用户存储的 OpenSSH 公钥比对；被接受的公钥会更新 `last_used` 时间戳
  （`server/session.rs`，`_auth_publickey*` 处理函数）。
- **密码** —— 作为 `AuthCredential::Password` 提交，通过 `ConfigProvider::validate_credential`
  （`crates/gated-core/src/config_providers/db.rs`）与 Argon2 哈希比对。
- **Keyboard-interactive** —— 用于第二因素：提示输入 TOTP 验证码（`AuthCredential::Otp`），或在策略要求浏览器
  批准时打印登录 URL，并在认证状态存储的广播通道上等待用户在 Web UI 中批准（`server/session.rs`，
  `_auth_keyboard_interactive`）。

每次尝试都经过 `try_auth_lazy`（`server/session.rs`），它在共享的 `AuthStateStore` 中创建或复用一个
`AuthState`，并调用 `AuthState::verify()`，直到满足凭据策略（见 [auth.zh-CN.md](auth.zh-CN.md)）。成功的票据
密钥在连接内缓存，因此 russh 反复的认证回调不会额外消耗票据次数。

### 授权

状态机报告 `Accepted` 后，会话按名称解析目标并检查 `ConfigProvider::authorize_target`
（`crates/gated-core/src/config_providers/db.rs`）—— 用户必须与目标至少共享一个角色。之后才设置
`TargetSelection::Found`。

## 目标连接

出站连接由 `RemoteClient`（`crates/gated-protocol-ssh/src/client/mod.rs`）负责，通过 `RCCommand`/`RCEvent`
通道对驱动。连接是**延迟的**：由第一个通道级请求（shell / exec / 转发）触发，而不是在认证时
（`server/session.rs`，`maybe_connect_remote`）。

- **连接目标的凭据**来自目标的 `TargetSSHOptions`：密码认证，或公钥认证（使用每目标私钥或 gated 自己的客户端
  密钥，`client/mod.rs`，`ssh_auth_keys()`）；每目标绑定账户通过 `ssh_options_with_account`
  （`crates/gated-core/src/account_credentials.rs`）解析。RSA 目标优先使用 SHA-2，并对旧服务器回退重试 SHA-1。
- **主机密钥验证**使用 known-hosts 表，有三种模式（`SshHostKeyVerificationMode`）：自动接受、自动拒绝，或在用户
  的 PTY 中显示交互式提示（`server/session.rs`，`handle_unknown_host_key`）。不匹配时中止并给出详细信息。

## 通道与流模型

`BiMap<ServerChannelId, Uuid>` 把入站 russh 通道与出站通道 UUID 关联起来（`server/session.rs`）。会话运行一个
事件循环，事件来自多个来源（russh 处理器事件、远端客户端事件、管理端会话控制命令、控制台输入、服务输出），通过
内部事件中心串行化；写回客户端的数据由专门的 `ChannelWriter` 任务排序（`server/channel_writer.rs`）。

支持的操作（`ChannelOperation`，`crates/gated-protocol-ssh/src/common.rs`）：shell、exec、PTY 请求 / 尺寸变更、
环境变量、子系统（SFTP）、direct-tcpip（本地转发）、direct-streamlocal（UNIX socket）、远程转发（tcpip-forward
和 streamlocal-forward，包括由服务端发起回客户端的通道）、SSH agent 转发、X11 转发、信号、EOF / 关闭。

## 录制挂钩

会话中接入了两类录制器（格式见 [sessions-recordings-audit.zh-CN.md](sessions-recordings-audit.zh-CN.md)）：

- **TerminalRecorder** —— 每个 shell / exec 通道一个，开启录制时启动；带时间戳记录客户端输入、目标
  stdout/stderr 和 PTY 尺寸变更（`server/session.rs`，`start_terminal_recording` 及数据处理函数）。
- **TrafficRecorder / ConnectionRecorder** —— 每个转发的（主机，端口）或 socket 路径一个；把转发的 TCP/UNIX
  流量双向记录为 PCAP 文件（`server/session.rs`，`traffic_recorder_for`）。

录制器写入失败只会摘除该录制器，不会终止会话。

## 生命周期

- 会话在接受连接时登记到 `State`；用户认证成功后写入数据库行，句柄释放时移除会话（并关闭其行）
  （`crates/gated-core/src/state.rs`）。认证失败的连接写入一条列出所尝试方式的 `auth_login_rejected` 审计
  条目，不产生会话行。
- 管理员可以在 Web UI 中关闭实时会话；会话收到 `SessionHandleCommand::Close`，发出一条服务消息，并断开两端连接
  （`server/session.rs`，`handle_session_control`）。
- 空闲超时和 keepalive 由 russh 按 `ssh` 配置段中的值执行。
