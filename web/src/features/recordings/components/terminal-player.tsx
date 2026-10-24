import type { AsciiCastEvent, AsciiCastHeader, AsciiCastLine } from '@/features/recordings/types'
import { create as createPlayerImpl } from 'asciinema-player'
import { AlertTriangle, Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useRecordingCast } from '@/features/recordings/hooks/use-recording-queries'
import { useRecordingStream } from '@/features/recordings/hooks/use-recording-stream'
import { EmptyState } from '@/shared/components/empty-state'
import { Card, CardContent } from '@/shared/ui/card'
import 'asciinema-player/dist/bundle/asciinema-player.css'

// asciinema-player ships no @types; we declare just the surface we touch.
interface PlayerCallbacks {
  feed: (data: string) => void
  resize: (cols: number, rows: number) => void
  setState: (state: string) => void
}
interface PlayerInstance { dispose: () => void }
type AsciinemaSrc
  = | { data: AsciiCastLine[] }
    | ((cb: PlayerCallbacks, opts: unknown) => {
      init?: () => Promise<{ cols: number, rows: number, duration: number | undefined }>
      play: () => unknown
      stop: () => unknown
    })
type CreateFn = (src: AsciinemaSrc, el: HTMLElement, opts?: Record<string, unknown>) => PlayerInstance
const createPlayer = createPlayerImpl as CreateFn

// Same size as the web terminal; a wide session scrolls inside the frame
// rather than shrinking, and a narrow one is not blown up to the frame width.
const PLAYER_OPTIONS: Record<string, unknown> = {
  autoPlay: true,
  fit: false,
  terminalFontSize: '13px',
  controls: 'auto',
  terminalFontFamily: '\'JetBrains Mono\', ui-monospace, Menlo, Consolas, monospace',
  terminalLineHeight: 1.2,
}

const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

function isHeader(line: AsciiCastLine): line is AsciiCastHeader {
  return !Array.isArray(line)
}

function isOutputEvent(line: AsciiCastLine): line is AsciiCastEvent {
  return Array.isArray(line) && (line[1] === 'o' || line[1] === 'e')
}

interface TerminalPlayerProps {
  recordingId: string
  live: boolean
}

export function TerminalPlayer({ recordingId, live }: TerminalPlayerProps) {
  if (live)
    return <LiveTerminalPlayer recordingId={recordingId} />
  return <StaticTerminalPlayer recordingId={recordingId} />
}

function PlayerChrome({ children }: { children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden bg-[#0a0a0c]">
      <CardContent className="p-0">
        <div className="relative aspect-video w-full">
          {children}
        </div>
      </CardContent>
    </Card>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 text-[13px] text-[#d4d4d8]">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function PlayerError({ title, description }: { title: string, description?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <EmptyState icon={AlertTriangle} title={title} {...(description ? { description } : {})} />
    </div>
  )
}

function StaticTerminalPlayer({ recordingId }: { recordingId: string }) {
  const { t } = useTranslation()
  const cast = useRecordingCast(recordingId, true)
  const elRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!cast.data || cast.data.length === 0)
      return
    const el = elRef.current
    if (!el)
      return
    const player = createPlayer({ data: cast.data }, el, PLAYER_OPTIONS)
    return () => {
      player.dispose()
    }
  }, [cast.data])

  if (cast.isPending)
    return <PlayerChrome><Loading label={t('recordings.terminal.loading')} /></PlayerChrome>
  if (cast.isError)
    return <PlayerChrome><PlayerError title={t('recordings.terminal.error')} /></PlayerChrome>
  if (!cast.data || cast.data.length === 0)
    return <PlayerChrome><PlayerError title={t('recordings.terminal.empty')} /></PlayerChrome>

  return (
    <PlayerChrome>
      <div ref={elRef} data-testid="terminal-player-root" className="absolute inset-0 overflow-auto" />
    </PlayerChrome>
  )
}

// Live driver: asciinema's custom-driver hook lets us push frames from outside
// the player loop, so the player keeps a stable terminal canvas while we feed
// the WebSocket stream into it.
class LiveDriver {
  cols = FALLBACK_COLS
  rows = FALLBACK_ROWS
  private cb: PlayerCallbacks | null = null
  private fed = 0

  configure(frames: AsciiCastLine[]) {
    for (const f of frames) {
      if (isHeader(f)) {
        this.cols = f.width
        this.rows = f.height
        break
      }
    }
  }

  syncFrames(frames: AsciiCastLine[]) {
    if (this.cb === null)
      return
    for (; this.fed < frames.length; this.fed++) {
      const line = frames[this.fed]
      if (line === undefined)
        continue
      if (isHeader(line))
        this.cb.resize(line.width, line.height)
      else if (isOutputEvent(line))
        this.cb.feed(line[2])
    }
  }

  asSrc(): AsciinemaSrc {
    return (cb, _opts) => {
      this.cb = cb
      const init = async () => ({ cols: this.cols, rows: this.rows, duration: undefined })
      return {
        init,
        play: () => { cb.setState('playing') },
        stop: () => { this.cb = null },
      }
    }
  }
}

function LiveTerminalPlayer({ recordingId }: { recordingId: string }) {
  const stream = useRecordingStream(recordingId, true)
  return (
    <LiveCastPlayer
      streamKey={recordingId}
      started={stream.started}
      frames={stream.frames}
      lastError={stream.lastError}
    />
  )
}

export interface LiveCastPlayerProps {
  /** Remount key: the player is torn down/rebuilt when this changes. */
  streamKey: string
  started: boolean
  frames: AsciiCastLine[]
  lastError: Event | null
}

/**
 * Presentational live asciicast player. Renders a stream of `{ start, data }`
 * frames (see `LiveDriver`) into an asciinema player. Shared by the recording
 * live player and the read-only session monitor viewer — both feed identically
 * shaped frames, so the rendering is factored out here.
 */
export function LiveCastPlayer({ streamKey, started, frames, lastError }: LiveCastPlayerProps) {
  const { t } = useTranslation()
  const elRef = React.useRef<HTMLDivElement>(null)
  const driverRef = React.useRef<LiveDriver | null>(null)

  React.useEffect(() => {
    if (!started)
      return
    const el = elRef.current
    if (!el)
      return
    const driver = new LiveDriver()
    driver.configure(frames)
    driverRef.current = driver
    const player = createPlayer(driver.asSrc(), el, PLAYER_OPTIONS)
    driver.syncFrames(frames)
    return () => {
      player.dispose()
      driverRef.current = null
    }
    // Player should re-mount only on stream boundary — not on every frame;
    // frame syncs happen in the next effect.
    // eslint-disable-next-line react/exhaustive-deps
  }, [streamKey, started])

  React.useEffect(() => {
    driverRef.current?.syncFrames(frames)
  }, [frames])

  if (lastError !== null && !started)
    return <PlayerChrome><PlayerError title={t('recordings.terminal.error')} /></PlayerChrome>
  if (!started)
    return <PlayerChrome><Loading label={t('recordings.terminal.live')} /></PlayerChrome>

  return (
    <PlayerChrome>
      <div
        ref={elRef}
        data-testid="terminal-player-root"
        data-live="true"
        className="absolute inset-0 overflow-auto"
      />
    </PlayerChrome>
  )
}
