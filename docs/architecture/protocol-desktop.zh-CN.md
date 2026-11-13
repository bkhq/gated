# 远程桌面（RDP 与 VNC）

[English](protocol-desktop.md) | 简体中文

桌面目标只能从浏览器访问。gated 不提供 RDP 或 VNC 监听端口，原生客户端
（`mstsc`、VNC viewer）无法连接。浏览器打开 WebSocket，gated 以 RDP 或 VNC
客户端的身份连接目标（凭据对用户不可见），一个方向转发画面，另一个方向转发输入。

```
浏览器 canvas  <-- WebSocket：JSON 控制消息 + 二进制图像 -->  桥接层
                                                                |
                                      DesktopEvent / DesktopInput（通道）
                                                                |
                           gated-protocol-rdp (IronRDP)   gated-protocol-vnc (vnc-rs)
                                                                |
                                                              目标
```

## 目标、账号与角色

- `TargetOptions::Rdp { host, port=3389, username, domain?, password?, verify_tls=true, record_keystrokes=false }`
  与 `TargetOptions::Vnc { host, port=5900, password?, record_keystrokes=false }`
  （`crates/gated-common/src/config/target.rs`）。
- 凭据来自绑定的 `desktop-password` 账号（`username`、可选的 `domain`、`password`；
  VNC 只用密码），或目标上的内联字段，由 `account_credentials::desktop_login`
  （`crates/gated-core/src/account_credentials.rs`）选取。
- `roles.allow_clipboard`（默认关闭）为该角色授权的目标打开双向剪贴板，
  由 `ConfigProvider::authorize_clipboard` 按用户和目标判定。

## 桥接层（`crates/gated-admin/src/http_service/api/desktop`）

`GET /api/desktop/{target}` 升级为 WebSocket。查询参数：`account`（使用哪个绑定账号）、
`width` 与 `height`（浏览器窗口大小；RDP 目标会按这个大小建立桌面）。

准入条件与 Web 终端相同：登录会话、用户 API 令牌或限定到该目标的工单；`Origin` 校验；
有授权该目标的角色。工单和剪贴板权限每 10 秒复查一次，授权被撤销的会话会被关闭。
限制：每个用户 4 个桌面会话，全局 32 个，单条浏览器消息 4 MiB，剪贴板文本截断到 1 MiB。

会话以 `WebRDP` 或 `WebVNC` 登记，因此会话监控中可见，管理员可以关闭。

### 画面路径

协议客户端发出 `DesktopEvent`（`crates/gated-core/src/protocols/desktop.rs`）：尺寸变化、
BGRA 原始 / JPEG / PNG 矩形、复制矩形、光标形状、剪贴板文本、响铃。桥接层把它们写入网关侧的
帧缓冲，并按 64 像素的块标记变化区域。WebSocket 可写时，发送端取出变化区域，编码为 JPEG
（质量 90，不做色度抽样），小于 4 KiB 像素的区域直接发 RGBA。慢的浏览器因此收到更少、
更大的更新，不会积压队列。

### 传输格式

文本帧是带 `type` 字段的 JSON。

| 方向 | 消息 |
|---|---|
| 网关到浏览器 | `state`（`connecting`；`connected` 带 `details { session_id, address, username, clipboard }`；`closed` 带 `message`）、`resize { width, height }`、`clipboard { text }`、`bell`、`error { message }`、`cursor_default`、`cursor_hidden` |
| 浏览器到网关 | `pointer_event { x, y, buttons }`、`key_event { keysym?, scancode?, extended?, down }`、`wheel_event { x, y, vertical, delta }`、`clipboard { text }`、`refresh`、`resize { width, height }` |

二进制帧只发往浏览器：`[kind u8][x u16][y u16][width u16][height u16][data]`，小端序。
kind 1 是 RGBA 原始像素，2 是 JPEG，3 是 RGBA 光标形状（`x`、`y` 为热点）。

按键同时以浏览器掌握的两种形式发送：浏览器键盘布局下的字符 keysym，以及物理键位的
PC/AT set-1 扫描码。VNC 使用 keysym，RDP 使用扫描码，所以 RDP 下由目标的键盘布局决定字符。

展示给用户的错误是固定的句子（"Target rejected the credentials"、
"TLS negotiation with the target failed" 等），地址和协议细节只写入网关日志。

## RDP 客户端（`crates/gated-protocol-rdp`）

基于已发布的 IronRDP crate，没有 vendored 代码。

- **安全**：始终使用 TLS；目标支持时使用网络级认证（CredSSP，NTLM）。不提供传统的
  RDP 安全层。不支持 NLA 的目标（xrdp）在 TLS 会话内收到凭据。不支持 Kerberos：
  任何需要客户端自行发起网络请求的认证步骤都会被拒绝。
- **证书**：`verify_tls`（默认开启）用系统根证书和主机名校验目标证书。多数 Windows
  主机使用自签名证书，需要为它们关闭这个开关；关闭后网关与目标之间的 TLS 会话无法
  抵御主动攻击者。目标的“安全”页会显示目标出示的证书
  （`GET /admin/api/targets/{id}/upstream-certificate`，
  `gated_protocol_rdp::inspect_certificate`）：网关只完成 RDP 协商和 TLS 握手，随后即断开。
- **登录**：使用账号的用户名、域和密码自动登录。
- **图形**：位图更新和 RemoteFX，由 IronRDP 在网关上解码成图像。未启用图形管线通道
  （EGFX、H.264）。
- **尺寸**：连接时取浏览器窗口大小，每边限制在 200..8192，RGBA 像素总量不超过 64 MiB；之后的
  窗口变化通过 display control 通道发送，目标以重新激活应答。没有该通道的目标保持初始尺寸。
  目标自行上报的尺寸在连接时和每次重新激活时受同样的限制，超出则结束会话。
- **剪贴板**：仅文本（`CF_UNICODETEXT`，读取时可回退到 ANSI 文本）。没有 `allow_clipboard`
  时根本不打开剪贴板通道。文件和图片既不提供也不接受。
- **不转发**：音频、磁盘、打印机、智能卡、多显示器。

## VNC 客户端（`crates/gated-protocol-vnc`）

基于 `vnc-rs`。

- **安全**：VNC 认证（以密码前 8 个字符为密钥的 DES 挑战）或无认证。RFB 没有传输加密：
  网关与目标之间的画面、按键和挑战都以明文传输。VNC 目标应放在可信网段内。
- **编码**：Tight、ZRLE、CopyRect、Raw，以及光标和桌面尺寸伪编码。每秒请求 25 次更新。
- **尺寸**：由目标决定，浏览器的尺寸变化被忽略。
- **剪贴板**：文本；没有 `allow_clipboard` 时双向丢弃。

## 录像与回放

启用录像后，每个桌面会话都会被录制（`crates/gated-core/src/recordings/desktop.rs`）：
每行一个 JSON 条目，带以秒为单位的 `time`：`resize`、`png_image`（`keyframe` 标记整屏快照，
至少每 10 秒或每 2 MB 写一次）、`jpeg_image`、`copy_rect`、`pointer_input`、`wheel_input`；
仅当目标开启 `record_keystrokes` 时才有 `key_input`、`scancode_input` 和 `clipboard_input`。
按键录制默认关闭，因为输入的密码会进入录像。

`GET /admin/api/recordings/{id}/desktop` 以流的方式返回该文件。录像页面在 canvas 上回放：
播放与暂停、拖动定位（从最近的关键帧重新绘制）、1x 到 8x 倍速、记录的指针位置标记，
以及记录的按键和粘贴内容。

## 测试

- 两个协议 crate 和桥接层的单元测试。
- `tests/desktop/vnc.test.ts`（对 `x11vnc`）与 `tests/desktop/rdp.test.ts`（对 `xrdp`），
  镜像在 `tests/images/`。
- 自动化测试未覆盖：NLA 和动态调整尺寸，`xrdp` 不支持，需要 Windows 目标验证。
