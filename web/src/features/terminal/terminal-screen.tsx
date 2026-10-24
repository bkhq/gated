import type { ITheme } from '@xterm/xterm'
import type { HostKeyVerifyPrompt, StatusPayload, TerminalKind } from './codec'
import type { HostKeyVerifyLabels } from './host-key-verify-dialog'
import type { TerminalKey } from './key-sequence'
import type { TerminalKeyLabels } from './terminal-key-menu'
import type { BannerLabels, BannerStatus } from './terminal-status'
import type { TerminalConnection, TerminalStatusMenuLabels } from './terminal-status-menu'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import * as React from 'react'
import { useInfo } from '@/shared/hooks/use-info'
import { cn } from '@/shared/lib/utils'
import { HostKeyVerifyDialog } from './host-key-verify-dialog'
import { keySequence } from './key-sequence'
import { TerminalKeyMenu } from './terminal-key-menu'
import { deriveBannerStatus } from './terminal-status'
import { TerminalStatusMenu } from './terminal-status-menu'
import { TerminalWatermark } from './terminal-watermark'
import { useTerminalSocket } from './use-terminal-socket'
import '@xterm/xterm/css/xterm.css'

// Debounce window for ResizeObserver → fit() → sendResize. Below ~80ms the
// terminal flickers during smooth drags; above ~150ms drag-resize feels laggy.
const RESIZE_DEBOUNCE_MS = 100

// Default xterm color theme. Tuned for the dark surface in `bg-card`; the
// route can override via the `theme` prop if a feature needs custom colors.
const DEFAULT_THEME: ITheme = {
  background: '#0b0d12',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#0b0d12',
  selectionBackground: 'rgba(255, 255, 255, 0.20)',
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
  // xterm color theme override. Merged onto {@link DEFAULT_THEME}.
  theme?: Partial<ITheme>
  fontFamily?: string
  fontSize?: number
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
  theme,
  fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize = 13,
}: TerminalScreenProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const terminalRef = React.useRef<Terminal | null>(null)
  const fitAddonRef = React.useRef<FitAddon | null>(null)

  const [lastStatus, setLastStatus] = React.useState<StatusPayload | null>(null)
  const [connection, setConnection] = React.useState<TerminalConnection | null>(null)
  const [hostKeyPrompt, setHostKeyPrompt] = React.useState<HostKeyVerifyPrompt | null>(null)

  // Hook is created up-front so its callbacks are stable refs. sendInput /
  // sendResize / sendHostKeyDecision are useCallback'd inside the hook.
  const socket = useTerminalSocket({
    kind,
    targetName,
    enabled,
    onData: (payload) => {
      // xterm v6 accepts Uint8Array directly; it handles its own UTF-8 decoding.
      terminalRef.current?.write(payload)
    },
    onStatus: (payload) => {
      setLastStatus(payload)
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

    const mergedTheme: ITheme = theme === undefined
      ? DEFAULT_THEME
      : { ...DEFAULT_THEME, ...theme }

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily,
      fontSize,
      theme: mergedTheme,
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
  React.useEffect(() => {
    const term = terminalRef.current
    if (term === null)
      return
    const merged: ITheme = theme === undefined
      ? DEFAULT_THEME
      : { ...DEFAULT_THEME, ...theme }
    term.options.theme = { ...merged }
  }, [theme])

  React.useEffect(() => {
    const term = terminalRef.current
    if (term === null)
      return
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    // Font change can shift cell metrics → re-fit so cols/rows track.
    try {
      fitAddonRef.current?.fit()
    }
    catch {}
  }, [fontFamily, fontSize])

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

  const bannerStatus: BannerStatus = deriveBannerStatus(socket.readyState, lastStatus)
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
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          data-testid="terminal-screen-container"
          className="absolute inset-0 overflow-hidden bg-[#0b0d12] p-2"
        />
        <TerminalWatermark enabled={watermarkEnabled} username={watermarkUsername} />
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
        <TerminalKeyMenu onKey={handleKey} labels={keyBarLabels} />
      </div>
      <HostKeyVerifyDialog
        prompt={hostKeyPrompt}
        onDecision={handleHostKeyDecision}
        labels={hostKeyLabels}
      />
    </div>
  )
}
