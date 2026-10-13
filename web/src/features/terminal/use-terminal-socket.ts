import type {
  HostKeyVerifyPrompt,
  StatusPayload,
  TerminalKind,
} from './codec'
import * as React from 'react'
import {
  clampResize,
  decodeFrame,
  encodeData,
  encodeHostKeyVerifyResponse,
  encodeResize,
} from './codec'

export type TerminalSocketReadyState = 'connecting' | 'open' | 'closed'

// Statuses after which the server will not deliver more frames on this socket
// (see docs/api.md §1.8). Receiving any of them turns off auto-reconnect so we
// don't spin against a permanently-failed session (e.g. 429 rate-limited).
const TERMINAL_STATUSES = new Set(['closed', 'error', 'rate_limited'])

export interface UseTerminalSocketOptions {
  kind: TerminalKind
  targetName: string
  /** Disable the socket without unmounting. Default: true. */
  enabled?: boolean
  /** Called per 0x00 DATA frame. Payload is a view into the receive buffer. */
  onData?: (payload: Uint8Array) => void
  /** Called per 0x02 STATUS frame. */
  onStatus?: (payload: StatusPayload) => void
  /** Called per 0x03 HOST_KEY_VERIFY frame (SSH only). */
  onHostKeyVerify?: (payload: HostKeyVerifyPrompt) => void
  /** Backoff base in ms. Default 500. */
  reconnectBaseMs?: number
  /** Backoff cap in ms. Default 30000 (matches server ping cadence in §1.8). */
  reconnectMaxMs?: number
}

export interface UseTerminalSocketResult {
  readyState: TerminalSocketReadyState
  /**
   * Status frame that terminated the session (status ∈ closed|error|
   * rate_limited), or null while the session is still viable. Stays set after
   * the socket closes so the UI banner can render the cause.
   */
  terminationReason: StatusPayload | null
  /** Send a 0x00 DATA frame with raw terminal input bytes. */
  sendInput: (bytes: Uint8Array) => void
  /** Send a 0x01 RESIZE frame. Clamped per kind (u16 for my/pg, u32 for ssh). */
  sendResize: (cols: number, rows: number) => void
  /** Send a 0x03 HOST_KEY_VERIFY response. SSH only. */
  sendHostKeyDecision: (accepted: boolean) => void
  /** Stop the socket and disable further reconnect attempts. */
  close: () => void
  lastError: Event | null
}

function buildTerminalUrl(kind: TerminalKind, targetName: string): string {
  const u = new URL(
    `/api/${kind}/terminal/${encodeURIComponent(targetName)}`,
    location.origin,
  )
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

/**
 * React hook that owns the binary terminal WebSocket lifecycle for one target.
 *
 * - Connects to `/api/{kind}/terminal/{targetName}` with `binaryType =
 *   'arraybuffer'`, promoting `https:` → `wss:` for same-origin paths.
 * - Routes inbound frames through {@link decodeFrame} into per-opcode callbacks.
 * - Reconnects on unexpected close with exponential backoff capped at 30s.
 * - Suppresses reconnect once a terminal status frame (`closed` / `error` /
 *   `rate_limited`) arrives — the session is server-side gone and retrying
 *   would either re-fail (rate limit, missing target) or open a new PTY the
 *   user did not ask for.
 */
export function useTerminalSocket(
  options: UseTerminalSocketOptions,
): UseTerminalSocketResult {
  const {
    kind,
    targetName,
    enabled = true,
    onData,
    onStatus,
    onHostKeyVerify,
    reconnectBaseMs = 500,
    reconnectMaxMs = 30000,
  } = options

  const [readyState, setReadyState] = React.useState<TerminalSocketReadyState>('closed')
  const [terminationReason, setTerminationReason] = React.useState<StatusPayload | null>(null)
  const [lastError, setLastError] = React.useState<Event | null>(null)

  const socketRef = React.useRef<WebSocket | null>(null)
  const stoppedRef = React.useRef(false)
  const kindRef = React.useRef(kind)

  const onDataRef = React.useRef(onData)
  const onStatusRef = React.useRef(onStatus)
  const onHostKeyVerifyRef = React.useRef(onHostKeyVerify)

  React.useEffect(() => {
    onDataRef.current = onData
  }, [onData])
  React.useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])
  React.useEffect(() => {
    onHostKeyVerifyRef.current = onHostKeyVerify
  }, [onHostKeyVerify])
  React.useEffect(() => {
    kindRef.current = kind
  }, [kind])

  React.useEffect(() => {
    if (!enabled)
      return undefined

    const ac = new AbortController()
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    stoppedRef.current = false
    // A new effect run = a fresh session. Clear any prior termination so the
    // UI banner doesn't stick across (re)mounts of the same component.
    // eslint-disable-next-line react/set-state-in-effect
    setTerminationReason(null)

    function connect(): void {
      if (ac.signal.aborted || stoppedRef.current)
        return
      const finalUrl = buildTerminalUrl(kind, targetName)
      // Surface the connecting phase synchronously so a banner can render it
      // before the handshake settles.
      // eslint-disable-next-line react/set-state-in-effect
      setReadyState('connecting')
      let ws: WebSocket
      try {
        ws = new WebSocket(finalUrl)
      }
      catch (err) {
        // eslint-disable-next-line react/set-state-in-effect
        setLastError(err as Event)
        scheduleReconnect()
        return
      }
      ws.binaryType = 'arraybuffer'
      socketRef.current = ws

      ws.addEventListener('open', () => {
        if (ac.signal.aborted) {
          ws.close()
          return
        }
        attempt = 0
        setReadyState('open')
      }, { signal: ac.signal })

      ws.addEventListener('message', (event: MessageEvent) => {
        if (!(event.data instanceof ArrayBuffer))
          return
        const frame = decodeFrame(event.data)
        if (frame === null)
          return
        switch (frame.type) {
          case 'data':
            onDataRef.current?.(frame.payload)
            break
          case 'status':
            onStatusRef.current?.(frame.payload)
            if (TERMINAL_STATUSES.has(frame.payload.status)) {
              stoppedRef.current = true
              setTerminationReason(frame.payload)
            }
            break
          case 'host_key_verify':
            onHostKeyVerifyRef.current?.(frame.payload)
            break
          case 'unknown':
            // Forward-compat: server may add opcodes. Drop silently rather
            // than crash the terminal.
            break
        }
      }, { signal: ac.signal })

      ws.addEventListener('error', (event: Event) => {
        setLastError(event)
      }, { signal: ac.signal })

      ws.addEventListener('close', () => {
        setReadyState('closed')
        socketRef.current = null
        if (!ac.signal.aborted && !stoppedRef.current)
          scheduleReconnect()
      }, { signal: ac.signal })
    }

    function scheduleReconnect(): void {
      if (ac.signal.aborted || stoppedRef.current)
        return
      const delay = Math.min(reconnectBaseMs * 2 ** attempt, reconnectMaxMs)
      attempt += 1
      reconnectTimer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      ac.abort()
      stoppedRef.current = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const ws = socketRef.current
      socketRef.current = null
      if (ws !== null && ws.readyState !== WebSocket.CLOSED)
        ws.close()
    }
  }, [enabled, kind, targetName, reconnectBaseMs, reconnectMaxMs])

  const sendInput = React.useCallback((bytes: Uint8Array) => {
    const ws = socketRef.current
    if (ws !== null && ws.readyState === WebSocket.OPEN)
      ws.send(encodeData(bytes))
  }, [])

  const sendResize = React.useCallback((cols: number, rows: number) => {
    const ws = socketRef.current
    if (ws === null || ws.readyState !== WebSocket.OPEN)
      return
    const clamped = clampResize(cols, rows, kindRef.current)
    ws.send(encodeResize(clamped.cols, clamped.rows))
  }, [])

  const sendHostKeyDecision = React.useCallback((accepted: boolean) => {
    const ws = socketRef.current
    if (ws !== null && ws.readyState === WebSocket.OPEN)
      ws.send(encodeHostKeyVerifyResponse(accepted))
  }, [])

  const close = React.useCallback(() => {
    stoppedRef.current = true
    const ws = socketRef.current
    if (ws !== null && ws.readyState !== WebSocket.CLOSED)
      ws.close()
  }, [])

  return {
    readyState,
    terminationReason,
    sendInput,
    sendResize,
    sendHostKeyDecision,
    close,
    lastError,
  }
}
