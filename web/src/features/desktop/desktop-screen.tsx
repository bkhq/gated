import type { ClientMessage, ConnectedDetails, DesktopState, ImageFrame } from './lib/protocol'
import { Clipboard, ClipboardX, Keyboard, RotateCw } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { keyMessage } from './lib/keys'
import {
  canvasPoint,
  desktopUrl,
  IMAGE_CURSOR,
  IMAGE_JPEG,
  IMAGE_RAW,
  parseImageFrame,
  parseServerMessage,
  pointerButtons,
  wheelMessage,
} from './lib/protocol'

// Browsers ignore larger custom cursors.
const MAX_CURSOR_EDGE = 128
const RESIZE_DEBOUNCE_MS = 300
const MIN_REQUESTED_EDGE = 200

const CTRL_ALT_DEL = [
  { key: 'Control', code: 'ControlLeft' },
  { key: 'Alt', code: 'AltLeft' },
  { key: 'Delete', code: 'Delete' },
]

export interface DesktopScreenProps {
  targetName: string
  /** Account picked for the target when the user's roles offer several. */
  account?: string
  className?: string
}

/** A live RDP or VNC session. Reconnecting mounts a fresh session. */
export function DesktopScreen(props: DesktopScreenProps) {
  const [attempt, setAttempt] = React.useState(0)
  return <DesktopSession key={attempt} {...props} onReconnect={() => setAttempt(n => n + 1)} />
}

function rgbaImage(frame: ImageFrame): ImageData | null {
  if (frame.width === 0 || frame.height === 0 || frame.data.length !== frame.width * frame.height * 4)
    return null
  return new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height)
}

async function drawFrame(context: CanvasRenderingContext2D, frame: ImageFrame): Promise<void> {
  if (frame.kind === IMAGE_RAW) {
    const image = rgbaImage(frame)
    if (image)
      context.putImageData(image, frame.x, frame.y)
  }
  else if (frame.kind === IMAGE_JPEG) {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(frame.data)], { type: 'image/jpeg' }))
    context.drawImage(bitmap, frame.x, frame.y)
    bitmap.close()
  }
}

/** CSS cursor for a pointer shape frame; its x and y are the hotspot. */
function cursorStyle(frame: ImageFrame): string {
  if (frame.width === 0 || frame.height === 0)
    return 'none'
  const image = frame.width <= MAX_CURSOR_EDGE && frame.height <= MAX_CURSOR_EDGE ? rgbaImage(frame) : null
  if (!image)
    return 'default'
  const shape = document.createElement('canvas')
  shape.width = frame.width
  shape.height = frame.height
  const context = shape.getContext('2d')
  if (!context)
    return 'default'
  context.putImageData(image, 0, 0)
  return `url(${shape.toDataURL()}) ${frame.x} ${frame.y}, default`
}

function DesktopSession({ targetName, account, className, onReconnect }: DesktopScreenProps & { onReconnect: () => void }) {
  const { t } = useTranslation()
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const clipboardRef = React.useRef(false)
  const heldKeysRef = React.useRef(new Map<string, { key: string, code: string }>())
  const pendingMoveRef = React.useRef<ClientMessage | null>(null)
  const [state, setState] = React.useState<DesktopState>('connecting')
  const [message, setMessage] = React.useState<string | null>(null)
  const [details, setDetails] = React.useState<ConnectedDetails | null>(null)

  const send = React.useCallback((outgoing: ClientMessage | null) => {
    const socket = socketRef.current
    if (outgoing && socket && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(outgoing))
  }, [])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return
    const context = canvas.getContext('2d')
    const room = viewportRef.current
    const size = room && room.clientWidth >= MIN_REQUESTED_EDGE && room.clientHeight >= MIN_REQUESTED_EDGE
      ? { width: room.clientWidth, height: room.clientHeight }
      : undefined
    const socket = new WebSocket(desktopUrl(targetName, account, size))
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket
    // JPEG decoding is asynchronous; chaining keeps frames in arrival order.
    let draws: Promise<void> = Promise.resolve()
    const inOrder = (step: () => void | Promise<void>) => {
      draws = draws.then(step).catch(() => {})
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        const frame = parseImageFrame(event.data as ArrayBuffer)
        if (!frame)
          return
        if (frame.kind === IMAGE_CURSOR)
          canvas.style.cursor = cursorStyle(frame)
        else if (context)
          inOrder(async () => drawFrame(context, frame))
        return
      }
      const incoming = parseServerMessage(event.data)
      if (!incoming)
        return
      switch (incoming.type) {
        case 'state':
          setState(incoming.state)
          if (incoming.details) {
            setDetails(incoming.details)
            clipboardRef.current = incoming.details.clipboard
          }
          // A reason given earlier says more than the closing line.
          if (incoming.message && incoming.state === 'closed')
            setMessage(previous => previous ?? incoming.message ?? null)
          break
        case 'resize':
          inOrder(() => {
            canvas.width = incoming.width
            canvas.height = incoming.height
          })
          break
        case 'error':
          setMessage(incoming.message)
          break
        case 'clipboard':
          if (clipboardRef.current)
            void navigator.clipboard?.writeText(incoming.text).catch(() => {})
          break
        case 'cursor_default':
          canvas.style.cursor = 'default'
          break
        case 'cursor_hidden':
          canvas.style.cursor = 'none'
          break
        case 'bell':
          break
      }
    }
    socket.onclose = () => setState('closed')

    // Ask the target to match the space there is; targets that cannot ignore it.
    const viewport = viewportRef.current
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = viewport && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => {
            const width = Math.floor(viewport.clientWidth)
            const height = Math.floor(viewport.clientHeight)
            if (width >= MIN_REQUESTED_EDGE && height >= MIN_REQUESTED_EDGE && socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: 'resize', width, height } satisfies ClientMessage))
          }, RESIZE_DEBOUNCE_MS)
        })
      : null
    if (viewport)
      observer?.observe(viewport)

    // React attaches wheel listeners as passive; scrolling must not move the page.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = canvasPoint(event, canvas.getBoundingClientRect(), canvas)
      const outgoing = wheelMessage(event, point)
      if (outgoing && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(outgoing))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      clearTimeout(resizeTimer)
      observer?.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      socket.onmessage = null
      socket.onclose = null
      socket.close()
      socketRef.current = null
    }
  }, [targetName, account])

  const sendPointer = (event: React.PointerEvent<HTMLCanvasElement>, immediate: boolean) => {
    const canvas = event.currentTarget
    const point = canvasPoint(event, canvas.getBoundingClientRect(), canvas)
    const outgoing: ClientMessage = { type: 'pointer_event', ...point, buttons: pointerButtons(event.buttons) }
    if (immediate) {
      pendingMoveRef.current = null
      send(outgoing)
      return
    }
    // Moves are sent once per frame at most.
    const scheduled = pendingMoveRef.current !== null
    pendingMoveRef.current = outgoing
    if (!scheduled) {
      requestAnimationFrame(() => {
        send(pendingMoveRef.current)
        pendingMoveRef.current = null
      })
    }
  }

  const sendKey = (event: { key: string, code: string }, down: boolean) => {
    const outgoing = keyMessage(event, down)
    if (!outgoing)
      return
    const id = event.code || event.key
    if (down)
      heldKeysRef.current.set(id, { key: event.key, code: event.code })
    else
      heldKeysRef.current.delete(id)
    send(outgoing)
  }

  const releaseHeldKeys = () => {
    for (const held of [...heldKeysRef.current.values()])
      sendKey(held, false)
  }

  const sendClipboard = (text: string) => {
    if (clipboardRef.current && text)
      send({ type: 'clipboard', text })
  }

  const live = state === 'connected'
  const tone = state === 'connected'
    ? 'bg-[hsl(var(--success))]'
    : state === 'connecting' ? 'bg-[hsl(var(--info))]' : 'bg-muted-foreground'

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <div className="flex flex-none items-center gap-3 border-b border-border bg-card px-4 py-1.5 text-[12.5px]">
        <span role="status" aria-live="polite" className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', tone)} />
          <span>{t(`desktop.status.${state}`)}</span>
        </span>
        {details
          ? (
              <>
                <span className="mono text-muted-foreground">
                  {details.username ? `${details.username}@${details.address}` : details.address}
                </span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  {details.clipboard ? <Clipboard size={13} /> : <ClipboardX size={13} />}
                  <span>{t(details.clipboard ? 'desktop.clipboard.on' : 'desktop.clipboard.off')}</span>
                </span>
              </>
            )
          : null}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!live}
            onClick={() => {
              for (const key of CTRL_ALT_DEL)
                sendKey(key, true)
              for (const key of [...CTRL_ALT_DEL].reverse())
                sendKey(key, false)
              canvasRef.current?.focus()
            }}
          >
            <Keyboard size={14} />
            <span>{t('desktop.actions.ctrlAltDel')}</span>
          </Button>
        </div>
      </div>
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={t('desktop.canvas')}
          className="max-h-full max-w-full outline-none"
          onPointerDown={(event) => {
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture?.(event.pointerId)
            sendPointer(event, true)
          }}
          onPointerUp={event => sendPointer(event, true)}
          onPointerMove={event => sendPointer(event, false)}
          onContextMenu={event => event.preventDefault()}
          onKeyDown={(event) => {
            event.preventDefault()
            sendKey(event, true)
          }}
          onKeyUp={(event) => {
            event.preventDefault()
            sendKey(event, false)
          }}
          onBlur={releaseHeldKeys}
          onFocus={() => {
            if (clipboardRef.current)
              void navigator.clipboard?.readText?.().then(sendClipboard).catch(() => {})
          }}
          onPaste={event => sendClipboard(event.clipboardData.getData('text'))}
        />
        {state === 'closed'
          ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6">
                <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 text-center">
                  <div className="text-sm font-semibold">{t('desktop.closed.title')}</div>
                  <p className="mb-4 mt-1.5 text-[13px] text-muted-foreground">
                    {message ?? t('desktop.closed.description')}
                  </p>
                  <Button type="button" onClick={onReconnect}>
                    <RotateCw size={14} />
                    <span>{t('desktop.actions.reconnect')}</span>
                  </Button>
                </div>
              </div>
            )
          : null}
      </div>
    </div>
  )
}
