# 命令管控（命令 ACL）—— 设计说明

[English](command-control.md) | 简体中文

本文说明命令 ACL 功能在各代理之间的行为：每个协议代理如何对照 `command_acl_rule` 表评估命令，尤其是在规则
**加载**出错与得出评估**判定**时分别如何处理。

匹配器本身不依赖数据库（`gated-core/src/command_acl.rs`）；数据库桥接位于 `gated-core/src/command_acl_loader.rs`
（`load_enabled_rules`、`load_user_role_ids`、`DbCommandAclEnforcer`）。MySQL、Postgres 和 SSH 代理使用它。

## 默认关闭

没有启用的规则时规则集为空，所有命令都评估为 `Allow`。

## 规则加载出错时放行（所有代理）

当 ACL 规则集无法**加载**（数据库不可用、查询出错）时，三个代理都会**放行（fail-open）**：命令被转发而不是被
拦截。此行为不可配置。

理由：命令管控是叠加在堡垒机之上的策略层，堡垒机的首要职责是提供访问。策略数据库的短暂故障不能把所有用户挡在
所有目标之外（加载出错时拒绝就会造成这种后果）。降级状态会被显式暴露，而不是静默发生：

- 输出一条 `WARN` 日志（`command control degraded (fail-open)`），并且
- 每个受影响的命令恰好写入一条审计事件：
  - MySQL / Postgres：一条 `SqlAuditRecordingItem::Query`，`success = true`，
    `error = "acl-load-error: command control degraded (fail-open)"`。
  - SSH：一条 `ShellCommandRecordingItem::Command`，`acl_action = "allow"`，
    `outcome = "acl-load-error: command control degraded (fail-open)"`。

## 评估判定保持安全拦截

放行策略**只**适用于加载出错的路径。一旦规则集已加载并实际评估了命令，`Deny` 和 `Review` 仍然会**拦截**：

- MySQL / Postgres：`Deny` 和 `Review` 都拦截（数据库代理没有交互式审批路径；`Review` 记录为
  `blocked-review-unsupported`）。
- SSH `exec`：`Deny` 拦截；`Review` 暂停会话等待管理员批准 / 拒绝，带有限的超时，超时同样拦截。
- SSH PTY（尽力还原命令）：`Deny` 和 `Review` 都拦截。

## SSH 上按角色限定的规则

按角色限定的 ACL 规则在 SSH 上生效。操作用户的角色 UUID 在认证时解析一次（`load_user_role_ids`，与数据库代理
使用同一个加载器）并保存在会话中，随后传入 `AclContext.role_ids`，用于 `exec` 和尽力而为的 PTY 评估。如果角色
解析失败，集合保持为空（尽力而为），全局 / 协议 / 目标规则仍然生效。
