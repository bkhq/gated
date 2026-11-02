# Gated

[English](README.md) | 简体中文

面向 SSH、HTTPS、MySQL、PostgreSQL 和 Kubernetes 的智能堡垒机 / 访问网关。

基于 Warpgate 贡献者开发的 [Warpgate](https://github.com/warp-tech/warpgate)。

## 功能

- SSH、HTTPS、MySQL、PostgreSQL、Kubernetes 代理
- 面向 MySQL / PostgreSQL 目标的 Web SQL 控制台（只读安全、语句超时 30 秒、结果上限 5 MiB）
- Web SSH / 数据库终端（xterm.js over WebSocket）
- 管理员签发的用户 API 令牌（`X-Gated-Token`）
- 集中认证，支持双因素（TOTP）和 SSO（OpenID Connect）
- 基于角色的访问控制（RBAC）
- 会话录制与回放
- 带实时终端的 Web 管理界面
- 单一二进制，无外部依赖
- 100% 安全 Rust 编写

## 构建

```bash
# 前置条件：Rust、Bun、just
just bun install --frozen-lockfile
just bun run build
cargo build --release

# 数据库后端的 feature 开关
cargo build --features mysql,postgres
```

## 运维

安装、配置、备份 / 恢复、升级和审计处理见[运维指南](docs/operations.zh-CN.md)。

## 开发流程（前端 + 后端同源）

开发环境用 [`@nsio/nsl`](https://www.npmjs.com/package/@nsio/nsl) 作为本地反向代理，
让 Vite（前端）和 Rust 网关（后端）共用一个源 —— `http://gated.localhost:<NSL_PORT>`，
与生产环境完全一致。不需要 CORS 绕行，不需要 `server.proxy`，cookie 的行为与生产一致。

```text
http://gated.localhost:<port>/ui        → Vite（HMR，端口由 nsl 分配）
http://gated.localhost:<port>/api       → Rust 网关 /api
http://gated.localhost:<port>/admin/api → Rust 网关 /admin/api
```

`<port>` 是 `nsl status` 在 `proxy.listen` 下报告的端口 —— 全新安装的 nsl 为 `:3355`，
但共享开发机上的守护进程可能配置在别的端口（`:1355` 等）。`just dev` 的启动横幅会打印实际 URL。

两个进程都由 nsl 管理（Pattern A）：nsl 为每个子进程分配空闲端口，并把端口代回命令行。
Vite 原生读取 `PORT`；gated CLI 接受 `--admin-port`，因此 `just dev` 传入字面量占位符
`NSL_PORT`，由 nsl 在启动时改写。没有任何进程绑定硬编码端口。

`just dev` 使用本地、被 git 忽略的 `config.yaml` 运行网关（先用
`gated --config config.yaml unattended-setup ...` 创建一次）。在其中设置
`admin.tls: false`，让 nsl 能以明文 HTTP 代理到网关；生产环境应保持 TLS 开启。
`just dev` 下配置里的 `admin.listen` 端口无关紧要，因为 `--admin-port` 会覆盖它。

```bash
just bun install      # 首次运行时拉取 @nsio/nsl
just dev              # 后端 + 前端，Ctrl-C 同时停止两者
just nsl-status       # 守护进程状态和路由表
```

如果开发环境完全无法运行 nsl，退回到 `just bun run dev:bare`（仅前端，Vite 默认端口），
并让网关以 `tls: true` 在自己的源上运行 —— 但这样 cookie 的行为会与生产不同。

## 许可证

采用 [Apache License 2.0](LICENSE) 许可。

Gated 是 Warpgate 贡献者开发的 [Warpgate](https://github.com/warp-tech/warpgate) 的衍生作品。原 Warpgate 项目及其品牌归各自作者所有。完整署名见 [NOTICE](NOTICE)。
