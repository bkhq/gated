import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { useWebSocket } from '@/shared/hooks/use-web-socket'
import '@xterm/xterm/css/xterm.css'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

function buildWsUrl(targetName: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  return `${protocol}//${host}/api/targets/${encodeURIComponent(targetName)}/terminal`
}

export function Component() {
  const { targetName } = useParams<{ targetName: string }>()
  const { t } = useTranslation(['gateway', 'common'])

  const termDivRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [reconnectKey, setReconnectKey] = useState(0)

  const wsUrl = targetName ? buildWsUrl(targetName) : null

  // Initialize xterm
  useEffect(() => {
    if (!termDivRef.current) return

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

  const handleOpen = useCallback(() => {
    setStatus('connected')
    xtermRef.current?.clear()
  }, [])

  const handleClose = useCallback(() => {
    setStatus('disconnected')
    xtermRef.current?.writeln('\r\n\x1b[31m[disconnected]\x1b[0m')
  }, [])

  const handleMessage = useCallback((event: MessageEvent) => {
    if (typeof event.data === 'string') {
      xtermRef.current?.write(event.data)
    } else if (event.data instanceof ArrayBuffer) {
      const text = new TextDecoder().decode(event.data)
      xtermRef.current?.write(text)
    } else if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then(buf => {
        const text = new TextDecoder().decode(buf)
        xtermRef.current?.write(text)
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

  // Forward keyboard input
  useEffect(() => {
    const term = xtermRef.current
    if (!term) return
    const disposable = term.onData((data) => {
      if (status === 'connected') {
        send(data)
      }
    })
    return () => disposable.dispose()
  }, [send, status, reconnectKey])

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
