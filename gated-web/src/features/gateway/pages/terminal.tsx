import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { useWebSocket } from '@/shared/hooks/use-web-socket'
import '@xterm/xterm/css/xterm.css'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

// Binary frame protocol constants — must match backend
const MSG_TERMINAL_DATA = 0x00
const MSG_RESIZE = 0x01

function buildWsUrl(targetName: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  return `${protocol}//${host}/api/ssh/terminal/${encodeURIComponent(targetName)}`
}

export function Component() {
  const { targetName } = useParams<{ targetName: string }>()
  const { t } = useTranslation(['gateway', 'common'])

  const termDivRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [reconnectKey, setReconnectKey] = useState(0)

  const wsUrl = targetName != null && targetName !== '' ? buildWsUrl(targetName) : null

  // Initialize xterm
  useEffect(() => {
    if (!termDivRef.current)
      return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'monospace',
      theme: {
        background: '#1a1a1a',
      },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(termDivRef.current)
    fitAddon.fit()

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      term.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [reconnectKey])

  const sendRef = useRef<(data: string | ArrayBuffer) => void>(() => {})

  const handleOpen = useCallback(() => {
    setStatus('connected')
    xtermRef.current?.clear()

    // Send initial resize
    const fitAddon = fitAddonRef.current
    const term = xtermRef.current
    if (fitAddon != null && term != null) {
      const resizePayload = JSON.stringify({ cols: term.cols, rows: term.rows })
      const encoder = new TextEncoder()
      const payload = encoder.encode(resizePayload)
      const frame = new Uint8Array(1 + payload.length)
      frame[0] = MSG_RESIZE
      frame.set(payload, 1)
      sendRef.current(frame.buffer)
    }
  }, [])

  const handleClose = useCallback(() => {
    setStatus('disconnected')
    xtermRef.current?.writeln('\r\n\x1B[31m[disconnected]\x1B[0m')
  }, [])

  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      const view = new Uint8Array(event.data)
      if (view.length === 0)
        return
      const msgType = view[0]
      const payload = view.slice(1)

      if (msgType === MSG_TERMINAL_DATA) {
        const text = new TextDecoder().decode(payload)
        xtermRef.current?.write(text)
      }
      else {
        // Status or other message — parse JSON payload
        try {
          const text = new TextDecoder().decode(payload)
          const msg = JSON.parse(text) as { status?: string, message?: string }
          if (msg.status === 'error' || msg.status === 'closed') {
            xtermRef.current?.writeln(`\r\n\x1B[33m[${msg.message ?? msg.status}]\x1B[0m`)
          }
          else if (msg.status === 'connected') {
            // SSH session established
          }
          else if (msg.status != null) {
            xtermRef.current?.writeln(`\r\n\x1B[36m[${msg.message ?? msg.status}]\x1B[0m`)
          }
        }
        catch {
          // ignore parse errors
        }
      }
    }
    else if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then((buf) => {
        handleMessage({ data: buf } as MessageEvent)
      })
    }
  }, [])

  const { send } = useWebSocket({
    url: wsUrl,
    onOpen: handleOpen,
    onClose: handleClose,
    onMessage: handleMessage,
    binaryType: 'arraybuffer',
    reconnect: false,
  })

  // Keep sendRef up to date
  useEffect(() => {
    sendRef.current = send
  }, [send])

  // Forward keyboard input with binary frame protocol
  useEffect(() => {
    const term = xtermRef.current
    if (!term)
      return
    const disposable = term.onData((data) => {
      if (status === 'connected') {
        const encoder = new TextEncoder()
        const payload = encoder.encode(data)
        const frame = new Uint8Array(1 + payload.length)
        frame[0] = MSG_TERMINAL_DATA
        frame.set(payload, 1)
        send(frame.buffer)
      }
    })
    return () => disposable.dispose()
  }, [send, status, reconnectKey])

  // Send resize when terminal dimensions change
  useEffect(() => {
    const term = xtermRef.current
    if (!term || status !== 'connected')
      return
    const disposable = term.onResize(({ cols, rows }) => {
      const resizePayload = JSON.stringify({ cols, rows })
      const encoder = new TextEncoder()
      const payload = encoder.encode(resizePayload)
      const frame = new Uint8Array(1 + payload.length)
      frame[0] = MSG_RESIZE
      frame.set(payload, 1)
      send(frame.buffer)
    })
    return () => disposable.dispose()
  }, [send, status, reconnectKey])

  // Re-fit and send resize on window resize
  useEffect(() => {
    if (status !== 'connected')
      return
    const handleWindowResize = () => {
      const fitAddon = fitAddonRef.current
      if (fitAddon != null) {
        fitAddon.fit()
      }
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [status])

  function handleReconnect() {
    setStatus('connecting')
    setReconnectKey(k => k + 1)
  }

  const statusColor: Record<ConnectionStatus, 'default' | 'secondary' | 'destructive'> = {
    connecting: 'secondary',
    connected: 'default',
    disconnected: 'destructive',
  }

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] gap-2">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-lg font-heading font-semibold">
          {t('gateway:pages.terminal', { targetName: targetName ?? '' })}
        </h1>
        <div className="flex items-center gap-2">
          <Badge variant={statusColor[status]}>
            {t(`gateway:terminal.status.${status}`)}
          </Badge>
          {status === 'disconnected' && (
            <Button size="sm" variant="outline" onClick={handleReconnect}>
              <RefreshCw className="size-3.5 mr-1" />
              {t('gateway:terminal.reconnect')}
            </Button>
          )}
        </div>
      </div>
      <div
        ref={termDivRef}
        className="flex-1 rounded-lg overflow-hidden bg-[#1a1a1a]"
        style={{ minHeight: 0 }}
      />
    </div>
  )
}
