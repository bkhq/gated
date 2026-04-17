import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocket } from '@/shared/hooks/use-web-socket'
import '@xterm/xterm/css/xterm.css'

const MSG_TERMINAL_DATA = 0x00
const MSG_RESIZE = 0x01

function buildWsUrl(targetName: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  return `${protocol}//${host}/api/ssh/terminal/${encodeURIComponent(targetName)}`
}

interface TerminalPanelProps {
  targetName: string
  tabId: string
  isActive: boolean
}

export function TerminalPanel({ targetName, tabId, isActive }: TerminalPanelProps) {
  const termDivRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')

  const wsUrl = buildWsUrl(targetName)
  const sendRef = useRef<(data: string | ArrayBuffer) => void>(() => {})

  // Initialize xterm once
  useEffect(() => {
    if (!termDivRef.current)
      return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '\'JetBrains Mono\', \'Fira Code\', monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
      },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(termDivRef.current)
    fitAddon.fit()

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    return () => {
      term.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [tabId])

  // Re-fit when tab becomes active
  useEffect(() => {
    if (isActive && fitAddonRef.current != null) {
      setTimeout(() => fitAddonRef.current?.fit(), 50)
    }
  }, [isActive])

  const handleOpen = useCallback(() => {
    setStatus('connected')
    xtermRef.current?.clear()
    const term = xtermRef.current
    const fitAddon = fitAddonRef.current
    if (term != null && fitAddon != null) {
      fitAddon.fit()
      const payload = JSON.stringify({ cols: term.cols, rows: term.rows })
      const encoder = new TextEncoder()
      const encoded = encoder.encode(payload)
      const frame = new Uint8Array(1 + encoded.length)
      frame[0] = MSG_RESIZE
      frame.set(encoded, 1)
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
        xtermRef.current?.write(new TextDecoder().decode(payload))
      }
      else {
        try {
          const text = new TextDecoder().decode(payload)
          const msg = JSON.parse(text) as { status?: string, message?: string }
          if (msg.status === 'error' || msg.status === 'closed') {
            xtermRef.current?.writeln(`\r\n\x1B[33m[${msg.message ?? msg.status}]\x1B[0m`)
          }
        }
        catch { /* ignore */ }
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

  useEffect(() => {
    sendRef.current = send
  }, [send])

  // Forward keyboard input
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
  }, [send, status])

  // Send resize
  useEffect(() => {
    const term = xtermRef.current
    if (!term || status !== 'connected')
      return
    const disposable = term.onResize(({ cols, rows }) => {
      const payload = JSON.stringify({ cols, rows })
      const encoder = new TextEncoder()
      const encoded = encoder.encode(payload)
      const frame = new Uint8Array(1 + encoded.length)
      frame[0] = MSG_RESIZE
      frame.set(encoded, 1)
      send(frame.buffer)
    })
    return () => disposable.dispose()
  }, [send, status])

  // Window resize -> re-fit
  useEffect(() => {
    if (!isActive || status !== 'connected')
      return
    const handleResize = () => fitAddonRef.current?.fit()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isActive, status])

  return (
    <div ref={termDivRef} className="w-full h-full" />
  )
}
