import type { HostKeyVerifyPrompt, StatusPayload, TerminalKind } from './codec'
import type { HostKeyVerifyLabels } from './host-key-verify-dialog'
import type { TerminalKey } from './key-sequence'
import type { TerminalFilesMode } from './terminal-files-dialog'
import type { TerminalKeyLabels } from './terminal-key-menu'
import type { TerminalShortcut } from './terminal-settings'
import type { BannerLabels, BannerStatus } from './terminal-status'
import type { TerminalConnection, TerminalStatusMenuLabels } from './terminal-status-menu'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Download, Plus, RotateCw, Settings, Upload } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useInfo } from '@/shared/hooks/use-info'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { HostKeyVerifyDialog } from './host-key-verify-dialog'
import { keySequence } from './key-sequence'
import { TerminalFilesDialog } from './terminal-files-dialog'
import { TerminalKeyMenu } from './terminal-key-menu'
import {
  DEFAULT_TERMINAL_SETTINGS,
  terminalFontFamily,
  terminalShortcut,
  terminalTheme,
  updateTerminalSettings,
  useTerminalSettings,
} from './terminal-settings'
import { TerminalSettingsDialog } from './terminal-settings-dialog'
import { deriveBannerStatus, progressLine } from './terminal-status'
import { TerminalStatusMenu } from './terminal-status-menu'
import { TerminalWatermark } from './terminal-watermark'
import { useTerminalSocket } from './use-terminal-socket'
import '@xterm/xterm/css/xterm.css'

// Debounce window for ResizeObserver → fit() → sendResize. Below ~80ms the
// terminal flickers during smooth drags; above ~150ms drag-resize feels laggy.
const RESIZE_DEBOUNCE_MS = 100

const ENDED_STATUSES = new Set(['closed', 'error', 'rate_limited'])

function endedLabelKey(status: string): string {
  if (status === 'closed')
    return 'terminal.status.closed'
  return status === 'rate_limited' ? 'terminal.status.rateLimited' : 'terminal.status.error'
}

function copyText(text: string): void {
  if (text)
    void navigator.clipboard?.writeText(text).catch(() => {})
}

export interface TerminalScreenProps {
  kind: TerminalKind
  targetName: string
  // Disable the socket without unmounting (e.g. while a confirm dialog blocks
  // user input upstream). Default: true.
  enabled?: boolean
  className?: string
  bannerLabels?: Partial<BannerLabels>
  hostKeyLabels?: Partial<HostKeyVerifyLabels>
  keyBarLabels?: Partial<TerminalKeyLabels>
  statusMenuLabels?: Partial<TerminalStatusMenuLabels>
  // Fired once per session-terminating status frame (closed/error/rate_limited)
  // so the route can navigate back or show a toast. Re-fires for each fresh
  // session if the user retries.
  onSessionEnd?: (payload: StatusPayload) => void
  // Fired whenever the connection status shown in the status bar changes.
  onStatusChange?: (status: BannerStatus) => void
  // Offered next to "Reconnect" once the session has ended.
  onNewConnection?: () => void
}

export function TerminalScreen({
  kind,
  targetName,
  enabled = true,
  className,
  bannerLabels,
  hostKeyLabels,
  keyBarLabels,
  statusMenuLabels,
  onSessionEnd,
  onStatusChange,
  onNewConnection,
}: TerminalScreenProps) {
  const { t } = useTranslation()
  const settings = useTerminalSettings()
  const settingsRef = React.useRef(settings)
  React.useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const terminalRef = React.useRef<Terminal | null>(null)
  const fitAddonRef = React.useRef<FitAddon | null>(null)

  const [lastStatus, setLastStatus] = React.useState<StatusPayload | null>(null)
  const [connection, setConnection] = React.useState<TerminalConnection | null>(null)
  const [hostKeyPrompt, setHostKeyPrompt] = React.useState<HostKeyVerifyPrompt | null>(null)
  const [connectionId, setConnectionId] = React.useState(0)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [files, setFiles] = React.useState<{ mode: TerminalFilesMode, dropped: File[] } | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const filesEnabled = kind === 'ssh'

  const writeLine = React.useCallback((line: string) => {
    terminalRef.current?.write(line)
  }, [])

  // Hook is created up-front so its callbacks are stable refs. sendInput /
  // sendResize / sendHostKeyDecision are useCallback'd inside the hook.
  const socket = useTerminalSocket({
    kind,
    targetName,
    enabled,
    connectionId,
    onData: (payload) => {
      // xterm v6 accepts Uint8Array directly; it handles its own UTF-8 decoding.
      terminalRef.current?.write(payload)
    },
    onStatus: (payload) => {
      setLastStatus(payload)
      if (payload.status === 'info' && payload.message)
        writeLine(progressLine(payload.message, 'progress'))
      else if (ENDED_STATUSES.has(payload.status))
        writeLine(progressLine(payload.message || t(endedLabelKey(payload.status)), payload.status === 'closed' ? 'ended' : 'failed'))
      if (payload.status === 'connected')
        setConnection({ connectedAt: new Date(), endedAt: null, details: payload.details })
      else if (payload.status === 'closed' || payload.status === 'error' || payload.status === 'rate_limited')
        setConnection(prev => (prev && prev.endedAt === null ? { ...prev, endedAt: new Date() } : prev))
    },
    onHostKeyVerify: (payload) => {
      setHostKeyPrompt(payload)
    },
  })

  // Bubble session-terminating status frames to the route. Re-runs only when
  // the payload object identity changes (one new ref per server frame).
  React.useEffect(() => {
    if (lastStatus === null)
      return
    if (
      lastStatus.status === 'closed'
      || lastStatus.status === 'error'
      || lastStatus.status === 'rate_limited'
    ) {
      onSessionEnd?.(lastStatus)
    }
  }, [lastStatus, onSessionEnd])

  // Reset banner + dialog state across re-targets so a fresh session starts
  // clean. The hook already clears its own termination reason on (re)mount.
  /* eslint-disable react/set-state-in-effect */
  React.useEffect(() => {
    setLastStatus(null)
    setHostKeyPrompt(null)
  }, [kind, targetName])
  /* eslint-enable react/set-state-in-effect */

  // One-time xterm bootstrap. Lives across (kind, targetName) changes; the
  // hook re-establishes the socket and we just continue streaming into the
  // same Terminal. Disposed on unmount only.
  React.useEffect(() => {
    const container = containerRef.current
    if (container === null)
      return undefined

    const initial = settingsRef.current
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: terminalFontFamily(initial),
      fontSize: initial.fontSize,
      theme: terminalTheme(initial),
      // 5k lines is enough for `journalctl -f` browsing without ballooning
      // memory on a long-running SSH session.
      scrollback: 5000,
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    terminalRef.current = term
    fitAddonRef.current = fit

    const dataDisposable = term.onData((input) => {
      const bytes = new TextEncoder().encode(input)
      socket.sendInput(bytes)
    })

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      socket.sendResize(cols, rows)
    })

    const selectionDisposable = term.onSelectionChange(() => {
      if (settingsRef.current.copyOnSelect && term.hasSelection())
        copyText(term.getSelection())
    })

    const runShortcut = (shortcut: TerminalShortcut) => {
      const size = settingsRef.current.fontSize
      switch (shortcut) {
        case 'copy':
          copyText(term.getSelection())
          break
        case 'paste':
          // term.paste keeps bracketed paste mode for the remote program.
          void navigator.clipboard?.readText().then(text => term.paste(text)).catch(() => {})
          break
        case 'zoom-in':
          updateTerminalSettings({ fontSize: size + 1 })
          break
        case 'zoom-out':
          updateTerminalSettings({ fontSize: size - 1 })
          break
        case 'zoom-reset':
          updateTerminalSettings({ fontSize: DEFAULT_TERMINAL_SETTINGS.fontSize })
          break
      }
    }
    term.attachCustomKeyEventHandler((event) => {
      const shortcut = terminalShortcut(event, settingsRef.current)
      if (shortcut === null)
        return true
      if (event.type === 'keydown') {
        event.preventDefault()
        runShortcut(shortcut)
      }
      return false
    })

    // First fit after the parent has been laid out (next animation frame),
    // so cols/rows reflect the real container size before the first resize
    // frame is sent.
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
      }
      // Fit can throw if the container has been removed between the rAF
      // schedule and its callback. Swallow — the next ResizeObserver tick
      // will re-fit if the element returns.
      catch {}
    })

    return () => {
      cancelAnimationFrame(raf)
      dataDisposable.dispose()
      resizeDisposable.dispose()
      selectionDisposable.dispose()
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
    // socket callbacks (sendInput/sendResize) are stable across renders
    // (`React.useCallback` in the hook). We intentionally do NOT re-create
    // the Terminal when other props change — see the props-update effect below.
    // eslint-disable-next-line react/exhaustive-deps
  }, [])

  // Live-update xterm theme/font without recreating the Terminal. xterm
  // requires a fresh object reference for option diffs (per its docs).
  const theme = terminalTheme(settings)
  const fontFamily = terminalFontFamily(settings)
  const themeKey = JSON.stringify(theme)
  React.useEffect(() => {
    const term = terminalRef.current
    if (term === null)
      return
    term.options.theme = JSON.parse(themeKey) as typeof theme
  }, [themeKey])

  React.useEffect(() => {
    const term = terminalRef.current
    if (term === null)
      return
    term.options.fontFamily = fontFamily
    term.options.fontSize = settings.fontSize
    // Font or padding changes shift the cell grid → re-fit so cols/rows track.
    try {
      fitAddonRef.current?.fit()
    }
    catch {}
  }, [fontFamily, settings.fontSize, settings.padding])

  // Connection progress, written into the terminal ahead of the session output.
  React.useEffect(() => {
    if (socket.readyState === 'connecting')
      writeLine(progressLine(t('terminal.progress.connecting', { target: targetName }), 'progress'))
    else if (socket.readyState === 'open')
      writeLine(progressLine(t('terminal.progress.signingIn'), 'progress'))
  }, [socket.readyState, targetName, t, writeLine])

  // ResizeObserver → debounced fit. fit() triggers term.onResize → sendResize.
  React.useEffect(() => {
    const container = containerRef.current
    if (container === null)
      return undefined

    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer !== null)
        clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try {
          fitAddonRef.current?.fit()
        }
        // Same rationale as the initial fit — swallow geometry errors and
        // wait for the next observation.
        catch {}
      }, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(container)

    return () => {
      if (timer !== null)
        clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // Operator-identity + timestamp watermark. Both the toggle and the username
  // come from the shared `/info` query. The overlay is a pure DOM/CSS layer —
  // it never touches the xterm write path.
  const info = useInfo()
  const watermarkEnabled = info.data?.terminal_watermark_enabled ?? false
  const watermarkUsername = info.data?.username ?? null

  const bannerStatus: BannerStatus = deriveBannerStatus(lastStatus)
  React.useEffect(() => {
    onStatusChange?.(bannerStatus)
  }, [bannerStatus, onStatusChange])

  // Focus xterm once per connection, after the server confirms it and no
  // host-key prompt is pending. Re-armed whenever the socket leaves 'open'.
  const autoFocusedRef = React.useRef(false)
  React.useEffect(() => {
    if (socket.readyState !== 'open') {
      autoFocusedRef.current = false
      return
    }
    if (autoFocusedRef.current || lastStatus?.status !== 'connected' || hostKeyPrompt !== null)
      return
    autoFocusedRef.current = true
    terminalRef.current?.focus()
  }, [socket.readyState, lastStatus, hostKeyPrompt])

  const handleHostKeyDecision = React.useCallback((accepted: boolean) => {
    socket.sendHostKeyDecision(accepted)
    setHostKeyPrompt(null)
  }, [socket])

  const reconnect = React.useCallback(() => {
    setLastStatus(null)
    setConnection(null)
    setHostKeyPrompt(null)
    setConnectionId(id => id + 1)
  }, [])

  const handleKey = React.useCallback((key: TerminalKey) => {
    const term = terminalRef.current
    const applicationCursor = term?.modes.applicationCursorKeysMode ?? false
    socket.sendInput(new TextEncoder().encode(keySequence(key, applicationCursor)))
    term?.focus()
  }, [socket])

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* The xterm host is absolutely positioned to fill this bounded wrapper.
          Otherwise the terminal's own content height feeds back into the flex
          layout, FitAddon computes ever-more rows, and the prompt flickers as
          resize events loop (seen with full-screen TUI clients like mycli). */}
      <div
        className="relative min-h-0 flex-1"
        onDragOver={(event) => {
          if (filesEnabled && event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target)
            setDragging(false)
        }}
        onDrop={(event) => {
          if (!filesEnabled)
            return
          event.preventDefault()
          setDragging(false)
          const dropped = Array.from(event.dataTransfer.files)
          if (dropped.length > 0)
            setFiles({ mode: 'upload', dropped })
        }}
      >
        <div
          ref={containerRef}
          data-testid="terminal-screen-container"
          className="absolute inset-0 overflow-hidden"
          style={{ background: theme.background, padding: settings.padding }}
        />
        <TerminalWatermark enabled={watermarkEnabled} username={watermarkUsername} />
        {dragging
          ? (
              <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-white/40 bg-black/40 text-sm text-zinc-100">
                {t('terminal.files.dropHint')}
              </div>
            )
          : null}
        {lastStatus !== null && ENDED_STATUSES.has(lastStatus.status)
          ? (
              <div role="status" className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 border-t border-white/10 bg-[#161a22]/95 px-3 py-2 text-[12.5px] text-zinc-200">
                <span className="min-w-0 flex-1 truncate">{lastStatus.message || t(endedLabelKey(lastStatus.status))}</span>
                <Button size="sm" onClick={reconnect}>
                  <RotateCw size={13} />
                  <span>{t('terminal.actions.reconnect')}</span>
                </Button>
                {onNewConnection
                  ? (
                      <Button size="sm" variant="secondary" onClick={onNewConnection}>
                        <Plus size={13} />
                        <span>{t('terminal.actions.newConnection')}</span>
                      </Button>
                    )
                  : null}
              </div>
            )
          : null}
      </div>
      <div className="flex h-7 flex-none items-center gap-3 bg-[#11141b] px-3 text-[11.5px] text-zinc-400">
        <TerminalStatusMenu
          status={bannerStatus}
          message={lastStatus?.message}
          connection={connection}
          kind={kind}
          targetName={targetName}
          bannerLabels={bannerLabels}
          labels={statusMenuLabels}
        />
        <span className="truncate font-mono text-zinc-500">{`${kind.toUpperCase()} · ${targetName}`}</span>
        <span className="flex-1" />
        {filesEnabled
          ? (
              <>
                <button type="button" className="focus-ring inline-flex h-5 items-center gap-1 rounded px-1.5 hover:bg-white/10 hover:text-zinc-200" title={t('terminal.files.upload')} onClick={() => setFiles({ mode: 'upload', dropped: [] })}>
                  <Upload size={13} />
                  <span>{t('terminal.files.upload')}</span>
                </button>
                <button type="button" className="focus-ring inline-flex h-5 items-center gap-1 rounded px-1.5 hover:bg-white/10 hover:text-zinc-200" title={t('terminal.files.download')} onClick={() => setFiles({ mode: 'download', dropped: [] })}>
                  <Download size={13} />
                  <span>{t('terminal.files.download')}</span>
                </button>
              </>
            )
          : null}
        <TerminalKeyMenu onKey={handleKey} labels={keyBarLabels} />
        <button type="button" className="focus-ring inline-flex h-5 items-center gap-1 rounded px-1.5 hover:bg-white/10 hover:text-zinc-200" aria-label={t('terminal.settings.title')} title={t('terminal.settings.title')} onClick={() => setSettingsOpen(true)}>
          <Settings size={13} />
        </button>
      </div>
      <HostKeyVerifyDialog
        prompt={hostKeyPrompt}
        onDecision={handleHostKeyDecision}
        labels={hostKeyLabels}
      />
      <TerminalSettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={updateTerminalSettings}
        onClose={() => {
          setSettingsOpen(false)
          terminalRef.current?.focus()
        }}
      />
      {files
        ? (
            <TerminalFilesDialog
              mode={files.mode}
              targetName={targetName}
              initialFiles={files.dropped}
              onClose={() => setFiles(null)}
            />
          )
        : null}
    </div>
  )
}
