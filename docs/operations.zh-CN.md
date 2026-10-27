# 运维 Gated

[English](operations.md) | 简体中文

## 构建与安装

使用 `rust-toolchain.toml` 固定的工具链、Bun、C/C++ 编译器、OpenSSL 开发头文件（用于内置的
加密 SQLite 构建）以及 `pkg-config`。可移植的 musl 构建还需要配置好的 musl 编译器。CI 和本地开发
使用的 GNU 路径如下：

```bash
cd web
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run test
cd ..
CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu cargo test --workspace --all-features --locked
CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu cargo build --release --all-features --locked
```

将 `target/x86_64-unknown-linux-gnu/release/gated` 安装在专用的非特权服务账户下。必须在最终的
Rust 二进制**之前**构建前端：UI 在编译时嵌入。保留上一版可执行文件及其对应配置以便回滚。不要把
源码检出目录当作不可变的发布产物来部署。

## 首次启动与配置

选择一个只有服务账户可写的私有数据目录，通过 `--data-dir`（或 `GATED_DATA_DIR`）传入。gated
随后读取 `<dir>/config.yaml`，并把数据库、主机密钥、TLS 密钥、录制和加密状态都保存在同一目录中，
配置中的路径相对该目录存储，因此整个目录可以作为一个整体备份、恢复或迁移。在一行中执行
`gated --data-dir /var/lib/gated unattended-setup --admin-port 8888
--ssh-port 2222 --external-host access.example.net --record-sessions`。初始密码通过部署密钥库
提供的 `GATED_ADMIN_PASSWORD` 环境变量传入；不要放进 shell 历史或命令行参数。初始化后取消设置该变量。
不要在已有安装上重复执行初始化。

初始化命令会生成配置和密钥。在启动 `gated --data-dir /var/lib/gated run` 之前检查这份配置。
不使用 `--data-dir` 时，由 `--config`（默认 `/etc/gated.yaml`）选择配置文件，相对路径以其所在目录
解析。容器镜像设置了 `GATED_DATA_DIR=/data`。保持配置、数据库、主机密钥、TLS 密钥和录制目录私有。
管理入口只绑定到运维网络或受信任的 TLS 反向代理。关闭不使用的协议。

在受信任的 TLS 终结器后面使用明文 HTTP 代理时，显式设置 `http.behind_proxy: true`，并把网络可达性
限制到该终结器。本地开发时，明文的 `http.listen: 127.0.0.1:8443` 无需绕过。不要关闭非回环明文监听的
保护。按实际管理源配置 `external_host` / `admin.external_port` 和 `admin.cookie_domain`；在该源上
测试 cookie 和 SSO 回调。

根目录的 `config.yaml` 是本地、被忽略的配置，不是可移植的部署示例。`just dev` 使用 GNU 构建和 nsl，
让 UI 和 API 同源。在全新检出上，先运行 `bun run build` 再单独做 typecheck，以便生成 TanStack 路由树。

## 凭据、信任与加密

- 添加目标角色，并把用户绑定到所需角色。API 令牌保留用户的权限；票据还会把访问限制到单个目标。
- SSH 默认 `auto_reject`。连接前在 Known Hosts 管理页登记经过验证的上游主机密钥。通过另一个受信任的
  渠道确认指纹。`prompt` 是显式的交互式 TOFU 选择；`auto_accept` 只适合一次性的测试环境。
- 验证上游 TLS 证书。配置合适的 CA 信任，而不是关闭验证。数据库目标必须支持所需的 TLS 模式；
  凭据降级会被拒绝。
- 修改密码需要当前密码。如果希望用户管理自己的凭据，在网关参数中开启自助凭据管理。OTP 绑定由服务端
  生成设置密钥，然后需要一个有效的实时验证码才会启用设备。保留另一条经过测试的管理员恢复路径。
- 设置 `encryption.enable: true` 后，通过管理启动页初始化 / 解锁。引导令牌生成在数据目录的
  `db/bootstrap-token.txt`；以服务报告的实际路径为准。在网关之外妥善保存主密码。重启处于锁定状态的
  部署需要按其配置的解锁流程操作。`meta.db` 必须与加密数据库一起备份；单独任何一个都不是可恢复的备份。
- 在已有明文 SQLite 数据库上初始化加密时，会在加密数据库旁保留原文件 `db.sqlite3.plain.bak`
  （开启文件保护时仅属主可读）。其中所有已存储的密钥都是未加密的。启动页和
  `encryption_plaintext_backup_retained` 审计日志会报告其路径；验证加密网关后，连同所有
  `-wal`/`-shm` 附属文件一起删除。CLI 路径下 `gated encrypt-existing-db --auto-delete-plaintext`
  会自动删除它。

## 备份与恢复

在维护窗口内做一致性备份：

1. 停止服务并等待进程退出，让 SQLite 和录制完成写入。通过服务管理器确认已停止。
2. 将**整个**数据目录、配置的录制目录（如在数据目录之外）、配置和可执行文件复制到受保护的备份中。
   包括残留的数据库附属文件、加密元数据以及 SSH/TLS 私钥。保留权限和属主。不要在进程运行时只复制
   主 SQLite 文件。
3. 随备份保存校验和清单以及确切的可执行文件 / 版本。像保护凭据一样保护备份：录制和数据库元数据都是
   敏感数据。
4. 重启并验证认证和一次真实的目标连接。

使用匹配的可执行文件和配置恢复到隔离目录，恢复属主，然后解锁并验证一个已知录制和目标。只有在这次演练
成功后才把服务切换到恢复出的目录。恢复的第一步绝不能是覆盖在用目录。对于外部托管的数据库，在同一窗口内
做数据库原生的一致性备份。

## 升级与回滚

做好经过测试的备份，停止旧进程，放置新二进制，并用现有配置重启。数据库迁移在启动时执行。测试登录、OTP、
目标授权、SSH 主机密钥验证、数据库查询和录制回放。回滚时恢复**匹配的数据库 / 配置 / 二进制组合**；
仅降级二进制不是安全的迁移回滚。不要在已有状态上重新初始化。

### 在 lode 下运行

[`deploy/lode/lode.toml`](../deploy/lode/lode.toml) 是 [lode](https://lode.bk.io) 守护器的示例配置。
它跟踪 bkhq/gated GitHub Releases 上签名的 `gated-linux-*.tar.gz` 归档，并在 `[command]` 中传入
绝对路径的 `--data-dir`，让所有状态都留在 lode 的版本目录之外。`gated run` 在收到 SIGTERM 时干净退出；
配合 `readiness = "state"`，它在监听器就绪后（启用加密时则在解锁前 UI 可用后）向 lode 报告就绪。保持
`policy = "check"`，并在备份后再应用更新：迁移在启动时执行，因此 lode 自动回滚到旧二进制并不是安全的
迁移回滚。

[`deploy/lode/Dockerfile`](../deploy/lode/Dockerfile) 基于 `bkhq/lode` slim 镜像为该部署构建容器镜像。
它加入了 Web MySQL 和 PostgreSQL 终端所启动的客户端（`mycli`，以 MariaDB 的 `mysql` 作为后备，以及
`psql`）；没有它们这些终端无法启动。gated 版本由 lode 自行下载，因此镜像不随 gated 版本变化。在
`/srv/gated-lode` 挂载卷，并把 `lode.toml` 放入其中。

## 监控与审计

检查配置的健康检查端点，并只在私有监听器上抓取指标。确认管理 UI 能从已安装的二进制加载，执行一次真实的
目标连接，并验证其录制可以回放。仅监听器就绪并不能证明端到端代理可用。

管理变更会在专用的 `management_audit` 表中持久化操作者、路径、方法、关联 ID 以及 requested /
completed 阶段。请求体、查询字符串、确认凭据和响应内容都不记录。只有 requested 而没有 completed 的记录
需要排查。浏览器登录使用独立的内存管理会话注册表，不产生代理会话行、指标或录制句柄。登录失败同样不产生
会话行；每次失败会在连接审计日志中写入一条 `auth_login_rejected`。修改密码会撤销其他浏览器会话和代理会话；
终止代理会话不会让操作者登出。

审计 UI 可选择目标连接（`POST /admin/api/logs`）或管理操作（`POST /admin/api/management-audit`）。只有
显式标记为 `audit` 的 tracing 事件会持久化；请求、查询和通道诊断仍只作为可观测性输出。连接记录在原生
SSH/MySQL/PostgreSQL/HTTP 上游连接成功后产生，每个会话每个目标一次。Web 终端保留其 `WebSSH`、`WebMySQL`
和 `WebPostgreSQL` 来源。

`log.management_retention` 与 `log.retention` 独立设置，两者默认都使用现有的保留期默认值。它们共享加密
数据库和备份边界，但管理记录没有代理会话外键，不会因删除会话而被删除。历史记录保留在 `log` 中并保留原始
协议名；新存储从部署切换时开始。down 迁移会在删除该表前把管理记录复制回 `log`。SQL 分组标识仍绑定到
用户和目标。

凭据明文查看需要可识别身份的管理员，加上当前密码或 OTP，以及非空的理由（最多 500 个字符）。共享管理令牌
无法识别操作者，不能查看凭据。限制为每个账户每分钟 5 次、每个操作者每分钟 10 次。OTP 查看限制为每个操作者
120 秒内一次；成功的 OTP 审计记录在重启后也能防止重放。UI 在提交后立即清除确认信息，并在关闭 / 隐藏或
60 秒后清除已显示的值；响应标记为 `no-store`。

显式开启录制，并在部署中设置磁盘保留 / 容量控制。如需防止数据库管理员篡改本地日志，把审计副本发送到独立
管理的存储。本版本不宣称提供防篡改的审计存储。

## 发布验证

`just clippy`、前端检查和工作区测试必须在本地通过。修改 API 后运行 `just openapi`，并在 `web/` 下运行
`bun run openapi --check` 检测已提交契约是否过期。在上游可达的主机上运行集成测试。本地通过并不能说明
代码托管平台运行了 CI 或已发布发布产物；生产上线前须单独确认。
