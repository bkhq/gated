import { useCallback, useEffect, useRef } from 'react'

export interface UseWebSocketOptions {
  url: string | null
  onMessage?: (event: MessageEvent) => void
  onOpen?: (event: Event) => void
  onClose?: (event: CloseEvent) => void
  onError?: (event: Event) => void
  binaryType?: BinaryType
  reconnect?: boolean
  reconnectInterval?: number
}

export function useWebSocket(options: UseWebSocketOptions) {
  const { url, onMessage, onOpen, onClose, onError, binaryType, reconnect = true, reconnectInterval = 3000 } = options
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const connect = useCallback(() => {
    if (url == null)
      return

    const ws = new WebSocket(url)
    if (binaryType)
      ws.binaryType = binaryType

    ws.onopen = (e) => {
      onOpen?.(e)
    }
    ws.onmessage = (e) => {
      onMessage?.(e)
    }
    ws.onclose = (e) => {
      onClose?.(e)
      if (reconnect && !e.wasClean) {
        reconnectTimerRef.current = setTimeout(connect, reconnectInterval)
      }
    }
    ws.onerror = (e) => {
      onError?.(e)
    }

    wsRef.current = ws
  }, [url, binaryType, onMessage, onOpen, onClose, onError, reconnect, reconnectInterval])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((data: string | ArrayBuffer | Blob) => {
    wsRef.current?.send(data)
  }, [])

  return { send, ws: wsRef }
}
