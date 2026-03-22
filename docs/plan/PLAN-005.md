# PLAN-005 管理 UI 全功能实现

## 基本信息

- **状态**: completed
- **创建时间**: 2026-03-22
- **优先级**: P1
- **关联任务**: UI-002 ~ UI-015

## 背景

gated-web 前端已完成架构迁移（React 19 + TanStack Query + shadcn/ui + i18n），但所有 57 个路由组件仍为占位符。需要基于 Admin API（96 个操作）和 Gateway API（30 个操作）实现完整的管理界面。

## 开发阶段

### Phase 1: 基础设施（P0）

#### UI-002 Auth 登录流程
- 登录页面（用户名/密码）
- OTP 二次验证页面
- SSO 登录（Provider 列表 + 跳转）
- 登出
- 路由守卫（未登录重定向）
- Auth 状态持久化（Zustand + cookie session）

#### UI-003 布局与导航
- Admin 侧边栏导航（所有资源入口）
- Gateway 顶部导航
- 面包屑
- 响应式布局（mobile sidebar drawer）
- 用户信息下拉菜单

### Phase 2: 核心资源管理（P1）

#### UI-004 用户管理
- 用户列表（搜索 + 分页）
- 创建用户表单
- 用户详情/编辑
- 删除用户（确认弹窗）
- 凭据管理标签页：
  - 密码（设置/重置）
  - 公钥（列表/添加/编辑/删除）
  - OTP（列表/添加/删除 + QR 码）
  - 证书（列表/签发/吊销）
  - SSO（列表/添加/编辑/删除）
- 角色分配（添加/移除角色）
- LDAP 关联（自动关联/取消关联）

**API 端点**: 22 个
**页面**: 用户列表、创建用户、用户详情（含标签页）

#### UI-005 目标管理
- 目标列表（搜索 + 按组过滤）
- 创建目标表单（SSH/HTTP/MySQL/PostgreSQL/Kubernetes 类型切换）
- 目标详情/编辑
- 删除目标
- 角色分配（添加/移除）
- SSH 已知主机密钥查看

**API 端点**: 10 个
**页面**: 目标列表、创建目标、目标详情

#### UI-006 目标组管理
- 目标组列表
- 创建/编辑/删除目标组

**API 端点**: 5 个
**页面**: 目标组列表、创建目标组、目标组详情

#### UI-007 角色管理
- 角色列表（搜索）
- 创建/编辑/删除角色
- 角色详情：关联用户列表 + 关联目标列表

**API 端点**: 7 个
**页面**: 角色列表、创建角色、角色详情

### Phase 3: 会话与审计（P1）

#### UI-008 会话管理
- 会话列表（分页 + 筛选：活跃/已登录）
- 会话详情（元数据 + 录制列表）
- 关闭活跃会话
- 批量清理过期会话

**API 端点**: 5 个
**页面**: 会话列表、会话详情

#### UI-009 录制回放
- 终端录制回放播放器（SSH asciicast）
- Kubernetes 会话录制查看
- 录制详情页

**API 端点**: 2 个
**页面**: 录制详情（含播放器）

#### UI-010 日志查看
- 日志列表（时间范围 + 筛选）
- 日志详情展开

**API 端点**: 1 个
**页面**: 日志页面

### Phase 4: 系统配置（P2）

#### UI-011 LDAP 服务器管理
- LDAP 服务器列表
- 创建/编辑/删除 LDAP 服务器
- 连接测试
- 用户列表查看 + 批量导入

**API 端点**: 8 个
**页面**: LDAP 列表、创建 LDAP、LDAP 详情

#### UI-012 SSH 密钥管理
- 已知主机列表（添加/删除）
- 主机密钥检查
- 自有公钥查看

**API 端点**: 6 个
**页面**: SSH 密钥页面

#### UI-013 工单管理
- 工单列表
- 创建工单（生成一次性密钥）
- 删除工单

**API 端点**: 3 个
**页面**: 工单列表、创建工单

#### UI-014 参数配置
- 全局参数查看/编辑表单

**API 端点**: 2 个
**页面**: 参数页面

### Phase 5: Gateway 用户端（P2）

#### UI-015 Gateway 用户功能
- 目标列表（可连接目标 + 连接命令展示）
- 个人资料页：
  - 修改密码
  - 管理公钥
  - 管理 OTP
  - 管理证书
- API Token 管理（列表/创建/删除）
- Web 终端（xterm.js SSH 连接）

**API 端点**: 12 个
**页面**: 目标列表、个人资料（标签页）、API Token、终端

## 共用组件需求

| 组件 | 用途 |
|------|------|
| DataTable | 通用数据表格（排序、搜索、分页） |
| ConfirmDialog | 删除确认弹窗 |
| FormField | 统一表单字段（label + input + error） |
| Badge / StatusBadge | 状态标签 |
| Tabs | 标签页切换 |
| Sheet / Dialog | 创建/编辑侧边栏或弹窗 |
| Skeleton | 加载骨架屏 |
| EmptyState | 空数据占位 |
| CopyButton | 复制到剪贴板 |
| Terminal | xterm.js 终端组件 |

## 技术方案

- **API 客户端**: OpenAPI Generator typescript-fetch（已配置）
- **请求缓存**: TanStack Query（每个资源 useXxxQuery / useXxxMutation）
- **表单**: react-hook-form + zod validation
- **表格**: @tanstack/react-table + shadcn DataTable
- **i18n**: 每个资源添加对应翻译 namespace

## 工作量估算

| 阶段 | 页面数 | API 集成 | 预估 |
|------|--------|----------|------|
| Phase 1 | 4 | 10 | 1 天 |
| Phase 2 | 10 | 44 | 3 天 |
| Phase 3 | 4 | 8 | 1 天 |
| Phase 4 | 6 | 19 | 1.5 天 |
| Phase 5 | 5 | 12 | 1.5 天 |
| 共用组件 | — | — | 1 天 |
| **总计** | **29** | **93** | **~9 天** |

## 风险

1. OpenAPI schema 与实际 API 不一致 — 需要集成测试验证
2. 录制回放需要自定义播放器 — asciicast 格式解析复杂度
3. Web 终端需要 WebSocket 稳定性处理 — 重连、超时
4. LDAP 配置表单字段较多 — 需要良好的 UX 分组

## 依赖

- shadcn/ui 组件补充（table, tabs, sheet, dialog, form, input, select, textarea, badge, skeleton, separator, alert-dialog, toast/sonner）
- react-hook-form + @hookform/resolvers + zod
- @tanstack/react-table
- asciinema-player 或自研播放器
