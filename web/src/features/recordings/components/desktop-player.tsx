import type { DesktopRecordingItem } from '@/features/recordings/lib/desktop-recording'
import type { Recording } from '@/shared/lib/api/recordings'
import { AlertTriangle, Download, Loader2, MonitorOff, Pause, Play } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { keysymLabel, scancodeLabel } from '@/features/desktop/lib/keys'
import { useRecordingDesktop } from '@/features/recordings/hooks/use-recording-queries'
import { itemsThrough, pointerBefore, recordingDuration, seekStart } from '@/features/recordings/lib/desktop-recording'
import { EmptyState } from '@/shared/components/empty-state'
import { recordingDesktopUrl } from '@/shared/lib/api/recordings'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'

const SPEEDS = [1, 2, 4, 8]
const SHOWN_INPUTS = 24
const SHOWN_PASTE_CHARS = 80

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

function formatClock(seconds: number): string {
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

interface RecordedInput { pasted: boolean, text: string }

/** A key press or a paste, as the input log shows it. */
function recordedInput(item: DesktopRecordingItem): RecordedInput | null {
  if (item.type === 'key_input' && item.down)
    return { pasted: false, text: keysymLabel(item.keysym) }
  if (item.type === 'scancode_input' && item.down)
    return { pasted: false, text: scancodeLabel(item.code, item.extended) }
  if (item.type === 'clipboard_input')
    return { pasted: true, text: item.text.slice(0, SHOWN_PASTE_CHARS) }
  return null
}

/** Draw one item. `onResize` hears about every change of the canvas size. */
async function drawItem(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  item: DesktopRecordingItem,
  onResize: (width: number, height: number) => void,
): Promise<void> {
  const resize = (width: number, height: number) => {
    if (canvas.width === width && canvas.height === height)
      return
    canvas.width = width
    canvas.height = height
    onResize(width, height)
  }
  if (item.type === 'resize') {
    resize(item.width, item.height)
  }
  else if (item.type === 'png_image' || item.type === 'jpeg_image') {
    // A keyframe is the whole screen, so playback can start from one.
    if (item.type === 'png_image' && item.keyframe === true)
      resize(item.rect.width, item.rect.height)
    const type = item.type === 'png_image' ? 'image/png' : 'image/jpeg'
    const bitmap = await createImageBitmap(new Blob([decodeBase64(item.data)], { type }))
    context.drawImage(bitmap, item.rect.x, item.rect.y)
    bitmap.close()
  }
  else if (item.type === 'copy_rect') {
    const { x, y, width, height } = item.dst
    context.drawImage(canvas, item.src_x, item.src_y, width, height, x, y, width, height)
  }
}

export function DesktopPlayer({ recording }: { recording: Recording }) {
  const { t } = useTranslation()
  const query = useRecordingDesktop(recording.id)

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-sm text-muted-foreground"
      >
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        <span>{t('recordings.desktop.loading')}</span>
      </div>
    )
  }
  if (query.isError)
    return <EmptyState icon={AlertTriangle} title={t('recordings.desktop.error')} />
  if (query.data.length === 0)
    return <EmptyState icon={MonitorOff} title={t('recordings.desktop.empty')} />

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="truncate">{recording.name}</CardTitle>
          <CardDescription>{t('recordings.desktop.title')}</CardDescription>
        </div>
        <a
          href={recordingDesktopUrl(recording.id)}
          download={`${recording.name}.jsonl`}
          className="focus-ring inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border px-3.5 text-sm font-medium text-foreground no-underline transition duration-150 ease-out hover:bg-muted"
        >
          <Download size={14} aria-hidden="true" />
          <span>{t('recordings.desktop.download')}</span>
        </a>
      </CardHeader>
      <CardContent>
        <DesktopPlayback items={query.data} />
      </CardContent>
    </Card>
  )
}

function DesktopPlayback({ items }: { items: DesktopRecordingItem[] }) {
  const { t } = useTranslation()
  const duration = recordingDuration(items)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  // How many items are on screen or queued to be drawn.
  const appliedRef = React.useRef(0)
  // Image decoding is asynchronous; chaining keeps items in order.
  const drawsRef = React.useRef<Promise<void>>(Promise.resolve())
  // Bumped when drawing restarts from a keyframe, so queued draws give up.
  const epochRef = React.useRef(0)
  const positionRef = React.useRef(0)
  const [position, setPosition] = React.useState(0)
  const [playing, setPlaying] = React.useState(true)
  const [speed, setSpeed] = React.useState(1)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [pointer, setPointer] = React.useState<{ x: number, y: number } | null>(null)
  const [inputs, setInputs] = React.useState<RecordedInput[]>([])

  const seek = React.useCallback((time: number) => {
    positionRef.current = time
    setPosition(time)
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context)
      return

    const target = itemsThrough(items, time)
    const applied = appliedRef.current
    const start = seekStart(items, applied, target)
    const restarted = start !== applied
    if (restarted)
      epochRef.current += 1
    const epoch = epochRef.current
    const onResize = (width: number, height: number) => setSize({ width, height })

    const labels: RecordedInput[] = []
    let moved: { x: number, y: number } | null = null
    for (let index = start; index < target; index++) {
      const item = items[index]!
      if (item.type === 'pointer_input')
        moved = { x: item.x, y: item.y }
      const label = recordedInput(item)
      if (label !== null)
        labels.push(label)
      drawsRef.current = drawsRef.current
        .then(async () => epoch === epochRef.current ? drawItem(canvas, context, item, onResize) : undefined)
        .catch(() => {})
    }
    appliedRef.current = target

    if (moved)
      setPointer(moved)
    else if (restarted)
      setPointer(pointerBefore(items, start))
    if (restarted || labels.length > 0)
      setInputs(previous => [...(restarted ? [] : previous), ...labels].slice(-SHOWN_INPUTS))
  }, [items])

  // Draws still queued have nothing to draw on once the player is gone.
  React.useEffect(() => () => {
    epochRef.current += 1
  }, [])

  React.useEffect(() => {
    if (!playing)
      return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const next = Math.min(duration, positionRef.current + (now - last) / 1000 * speed)
      last = now
      seek(next)
      if (next >= duration)
        setPlaying(false)
      else
        frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed, duration, seek])

  const toggle = () => {
    if (!playing && positionRef.current >= duration)
      seek(0)
    setPlaying(!playing)
  }

  const nextSpeed = () => {
    setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1)
  }

  return (
    <div className="grid gap-3">
      <div className="flex justify-center overflow-hidden rounded-md bg-[#0a0a0c]">
        <div className="relative max-w-full">
          <canvas
            ref={canvasRef}
            width={0}
            height={0}
            aria-label={t('recordings.desktop.canvas')}
            className="block h-auto max-w-full"
          />
          {pointer && size.width > 0 && size.height > 0 && (
            <div
              data-testid="recorded-pointer"
              aria-hidden="true"
              className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary/80"
              style={{ left: `${pointer.x / size.width * 100}%`, top: `${pointer.y / size.height * 100}%` }}
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={toggle}
          aria-label={playing ? t('recordings.desktop.pause') : t('recordings.desktop.play')}
        >
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </Button>
        <input
          type="range"
          min={0}
          max={duration}
          step={0.1}
          value={position}
          onChange={event => seek(Number(event.target.value))}
          aria-label={t('recordings.desktop.seek')}
          className="min-w-0 flex-1 accent-primary"
        />
        <span className="mono text-[12px] text-muted-foreground">
          {`${formatClock(position)} / ${formatClock(duration)}`}
        </span>
        <Button variant="outline" size="sm" onClick={nextSpeed} aria-label={t('recordings.desktop.speed')}>
          {`${speed}×`}
        </Button>
      </div>
      {inputs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[12px]">
          <span className="mr-1 text-muted-foreground">{t('recordings.desktop.inputs')}</span>
          {inputs.map((input, index) => (
            // eslint-disable-next-line react/no-array-index-key -- a log of repeating labels has no other identity
            <kbd key={index} className="mono rounded border border-border bg-muted px-1.5 py-0.5">
              {input.pasted ? t('recordings.desktop.pasted', { text: input.text }) : input.text}
            </kbd>
          ))}
        </div>
      )}
    </div>
  )
}
