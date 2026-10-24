import * as React from 'react'

export type WebSocketReadyState = 'connecting' | 'open' | 'closed'

export interface UseWebSocketOptions<TMessage> {
  /**
   * Same-origin path (e.g. '/admin/api/sessions/changes') or a full URL.
   * Path values are resolved against `location.origin`; scheme is promoted to
   * `wss:` when the page is served over HTTPS.
   */
  url: string | (() => string)
  /** Decode incoming MessageEvent.data. Default: JSON.parse. */
  decode?: (raw: string) => TMessage
  /** Called per decoded message. Decoder errors swallowed (lastError set). */
  onMessage?: (message: TMessage) => void
  /** Disable the socket without unmounting. Default: true. */
  enabled?: boolean
  /** Backoff base in ms. Default 500. Cap is 30s. */
  reconnectBaseMs?: number
  /** Max backoff in ms. Default 30000. */
  reconnectMaxMs?: number
}

export interface UseWebSocketResult {
  readyState: WebSocketReadyState
  send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => void
  close: () => void
  lastError: Event | null
}

function resolveUrl(input: string): string {
  if (input.startsWith('ws://') || input.startsWith('wss://'))
    return input
  const u = new URL(input, location.origin)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

function defaultDecode<TMessage>(raw: string): TMessage {
  return JSON.parse(raw) as TMessage
}

/**
 * Generic same-origin WebSocket hook with exponential reconnect backoff
 * (capped at 30s) and AbortController-driven teardown.
 */
export function useWebSocket<TMessage = unknown>(
  options: UseWebSocketOptions<TMessage>,
): UseWebSocketResult {
  const {
    url,
    decode,
    onMessage,
    enabled = true,
    reconnectBaseMs = 500,
    reconnectMaxMs = 30000,
  } = options

  const [readyState, setReadyState] = React.useState<WebSocketReadyState>('closed')
  const [lastError, setLastError] = React.useState<Event | null>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const onMessageRef = React.useRef(onMessage)
  const decodeRef = React.useRef(decode)
  // Resolve the target once per render so a changed URL (same component, new
  // route params) tears the old socket down and connects to the new one.
  const resolvedUrl = typeof url === 'function' ? url() : url

  React.useEffect(() => {
    onMessageRef.current = onMessage
  }, [onMessage])
  React.useEffect(() => {
    decodeRef.current = decode
  }, [decode])

  React.useEffect(() => {
    if (!enabled)
      return undefined

    const ac = new AbortController()
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect(): void {
      if (ac.signal.aborted)
        return
      const finalUrl = resolveUrl(resolvedUrl)
      // Setting state synchronously here is intentional: we surface the
      // "connecting" phase to consumers before the WebSocket handshake fires.
      // eslint-disable-next-line react/set-state-in-effect
      setReadyState('connecting')
      let ws: WebSocket
      try {
        ws = new WebSocket(finalUrl)
      }
      catch (err) {
        // construction itself failed (bad URL etc.) — treat as transient.
        // Synchronous setState here is intentional and equally rare.
        // eslint-disable-next-line react/set-state-in-effect
        setLastError(err as Event)
        scheduleReconnect()
        return
      }
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
        const dec = decodeRef.current ?? defaultDecode<TMessage>
        try {
          const raw = typeof event.data === 'string' ? event.data : ''
          if (raw.length === 0)
            return
          const decoded = dec(raw)
          onMessageRef.current?.(decoded)
        }
        catch (err) {
          setLastError(err as Event)
        }
      }, { signal: ac.signal })

      ws.addEventListener('error', (event: Event) => {
        setLastError(event)
      }, { signal: ac.signal })

      ws.addEventListener('close', () => {
        setReadyState('closed')
        socketRef.current = null
        if (!ac.signal.aborted)
          scheduleReconnect()
      }, { signal: ac.signal })
    }

    function scheduleReconnect(): void {
      if (ac.signal.aborted)
        return
      const delay = Math.min(reconnectBaseMs * 2 ** attempt, reconnectMaxMs)
      attempt += 1
      reconnectTimer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      ac.abort()
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const ws = socketRef.current
      socketRef.current = null
      if (ws !== null && ws.readyState !== WebSocket.CLOSED)
        ws.close()
    }
  }, [enabled, resolvedUrl, reconnectBaseMs, reconnectMaxMs])

  const send = React.useCallback(
    (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      const ws = socketRef.current
      if (ws !== null && ws.readyState === WebSocket.OPEN)
        ws.send(data)
    },
    [],
  )

  const close = React.useCallback(() => {
    const ws = socketRef.current
    if (ws !== null)
      ws.close()
  }, [])

  return { readyState, send, close, lastError }
}
