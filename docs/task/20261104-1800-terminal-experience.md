# 20261104-1800-terminal-experience Bring the web terminal closer to Google's SSH-in-browser

- **status**: pending
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-04 18:00

## Description

Improve the web SSH terminal using Google Cloud's SSH-in-browser as the reference. Acceptance: users can adjust the terminal (theme, colors, font, size, scrollbar, copy behaviour) from a settings menu kept per browser; copy/paste works with copy-on-select and Ctrl+Shift+C/V; files can be uploaded and downloaded from the terminal; a failed or closed connection offers reconnect in place.

## ActiveForm

Awaiting proposal approval

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings (reference bundle `sshinbrowser.ms.zh_CN`, strings and xterm options extracted with grep; no code reused):
- Settings menu ("设置"菜单): 主题背景 (theme presets), 自定义颜色 (字体颜色 / 背景颜色), 字体, 显示/隐藏滚动条, 选中即复制, 按 Ctrl+Shift+C/V 来复制/粘贴 (`enableCtrlShiftCopy`), padding around the terminal (`paddingAroundTerminal`); stored as user settings.
- Files: 上传文件 (upload drawer, 从您的计算机上传文件, 文件已存在), 下载文件 by 绝对文件路径.
- Connection: progress text (正在建立与 SSH 服务器的连接…), 连接失败 with the reason and troubleshooting hints, 新建连接.
- xterm defaults: `scrollback: 1000`, `screenReaderMode: true`, `cursorBlink: true`; `rightClickSelectsWord` on macOS; `copyOnSelect` copies on `onSelectionChange`.
- gated today (`features/terminal/`): fixed font (13 px, system monospace) and theme, `scrollback: 5000`, no settings, browser-default copy/paste only, files only through the separate file manager tab, status banner + status menu + mobile key bar + watermark; reconnect only by reopening the tab.

Proposed plan:
1. Settings menu (gear in the terminal toolbar), saved in `localStorage`, applied live: theme presets (dark, light, solarized dark/light) and custom foreground/background, font family (system monospace / JetBrains Mono / custom), font size (also Ctrl+= / Ctrl+-), show scrollbar, padding, copy-on-select, Ctrl+Shift+C/V.
2. Clipboard: copy-on-select via `onSelectionChange`; Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes (bracketed paste preserved) through `attachCustomKeyEventHandler`; Ctrl+C stays SIGINT.
3. Files in the terminal: "Upload file" (to the session's home or a typed absolute path, drag-and-drop onto the terminal) and "Download file" (absolute path), using the existing SFTP endpoints; conflicts ask before overwriting.
4. Connection: show progress lines in the terminal while connecting; on error or close keep the output and show the reason with "Reconnect" and "New connection" actions.
5. Tests: settings persistence and application, clipboard key handling, upload/download calls, reconnect; docs, changelog.

Out of scope: SSH key / security-key sign-in from the browser and IAP-specific hints (gated signs in with bound accounts).
