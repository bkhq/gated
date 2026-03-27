import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { cn } from '@/shared/lib/utils'
import '@xterm/xterm/css/xterm.css'

interface AsciicastHeader {
  version: 2
  width: number
  height: number
  title?: string
  duration?: number
}

type OutputEvent = [number, string] // [timestamp, data]

interface ParsedCast {
  header: AsciicastHeader
  events: OutputEvent[]
  duration: number
}

function parseCast(text: string): ParsedCast {
  const lines = text.trim().split('\n').filter(l => l.trim())
  if (!lines.length)
    throw new Error('Empty cast')
  const header = JSON.parse(lines[0]!) as AsciicastHeader
  const events: OutputEvent[] = []
  for (const line of lines.slice(1)) {
    try {
      const event = JSON.parse(line) as [number, string, string]
      if (event[1] === 'o') {
        events.push([event[0], event[2]])
      }
    }
    catch {
      // skip malformed lines
    }
  }
  const duration = events.length > 0 ? events.at(-1)![0] : 0
  return { header, events, duration }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const SPEEDS = [0.5, 1, 2, 4]

interface TerminalPlayerProps {
  castText: string
  className?: string
}

export function TerminalPlayer({ castText, className }: TerminalPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const castRef = useRef<ParsedCast | null>(null)

  // Playback state in refs (no re-render needed)
  const playingRef = useRef(false)
  const speedRef = useRef(1)
  const castTimeRef = useRef(0)
  const eventIdxRef = useRef(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // UI state
  const [uiPlaying, setUiPlaying] = useState(false)
  const [uiTime, setUiTime] = useState(0)
  const [uiDuration, setUiDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [parseError, setParseError] = useState<string | null>(null)
  // tracks cast identity to re-init terminal
  const [castKey, setCastKey] = useState(0)

  // Parse cast text
  useEffect(() => {
    try {
      const parsed = parseCast(castText)
      castRef.current = parsed
      setUiDuration(parsed.duration) // eslint-disable-line react-hooks-extra/no-direct-set-state-in-use-effect
      setParseError(null) // eslint-disable-line react-hooks-extra/no-direct-set-state-in-use-effect
      setCastKey(k => k + 1) // eslint-disable-line react-hooks-extra/no-direct-set-state-in-use-effect
    }
    catch {
      setParseError('Failed to parse recording data') // eslint-disable-line react-hooks-extra/no-direct-set-state-in-use-effect
    }
  }, [castText])

  // Initialize xterm terminal when cast changes
  useEffect(() => {
    if (!containerRef.current)
      return
    const cast = castRef.current
    if (!cast)
      return

    const term = new Terminal({
      cols: cast.header.width || 80,
      rows: cast.header.height || 24,
      fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 500,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)

    termRef.current = term

    // Reset playback state
    playingRef.current = false
    castTimeRef.current = 0
    eventIdxRef.current = 0
    setUiPlaying(false) // eslint-disable-line react-hooks-extra/no-direct-set-state-in-use-effect
    setUiTime(0) // eslint-disable-line react-hooks-extra/no-direct-set-state-in-use-effect

    return () => {
      if (timeoutRef.current)
        clearTimeout(timeoutRef.current)
      if (intervalRef.current)
        clearInterval(intervalRef.current)
      term.dispose()
      termRef.current = null
    }
  }, [castKey])

  const stopPlayback = useCallback(() => {
    playingRef.current = false
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setUiPlaying(false)
  }, [])

  const schedulePlayback = useCallback(() => {
    const term = termRef.current
    const cast = castRef.current
    if (!term || !cast)
      return

    function tick() {
      if (!playingRef.current)
        return
      const idx = eventIdxRef.current
      if (idx >= cast!.events.length) {
        playingRef.current = false
        castTimeRef.current = cast!.duration
        setUiTime(cast!.duration)
        setUiPlaying(false)
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
        return
      }
      const event = cast!.events[idx]
      if (!event)
        return
      const [ts, data] = event
      const delay = Math.max(0, (ts - castTimeRef.current) / speedRef.current * 1000)
      timeoutRef.current = setTimeout(() => {
        if (!playingRef.current)
          return
        term!.write(data)
        castTimeRef.current = ts
        eventIdxRef.current = idx + 1
        tick()
      }, delay)
    }

    tick()

    intervalRef.current = setInterval(() => {
      setUiTime(castTimeRef.current)
    }, 100)
  }, [])

  const play = useCallback(() => {
    const cast = castRef.current
    const term = termRef.current
    if (!cast || !term)
      return

    // If at end, restart
    if (castTimeRef.current >= cast.duration - 0.01) {
      term.reset()
      castTimeRef.current = 0
      eventIdxRef.current = 0
      setUiTime(0)
    }

    playingRef.current = true
    setUiPlaying(true)
    schedulePlayback()
  }, [schedulePlayback])

  const pause = useCallback(() => {
    stopPlayback()
  }, [stopPlayback])

  const reset = useCallback(() => {
    stopPlayback()
    const term = termRef.current
    if (term)
      term.reset()
    castTimeRef.current = 0
    eventIdxRef.current = 0
    setUiTime(0)
  }, [stopPlayback])

  const replayToTime = useCallback((term: Terminal, events: OutputEvent[], targetTime: number) => {
    term.reset()
    for (const [ts, data] of events) {
      if (ts > targetTime)
        break
      term.write(data)
    }
    const idx = events.findIndex(e => e[0] > targetTime)
    eventIdxRef.current = idx === -1 ? events.length : idx
    castTimeRef.current = targetTime
  }, [])

  const handleSeek = useCallback((value: number) => {
    const term = termRef.current
    const cast = castRef.current
    if (!term || !cast)
      return

    const wasPlaying = playingRef.current
    stopPlayback()
    replayToTime(term, cast.events, value)
    setUiTime(value)

    if (wasPlaying) {
      playingRef.current = true
      setUiPlaying(true)
      schedulePlayback()
    }
  }, [stopPlayback, replayToTime, schedulePlayback])

  const handleSpeedChange = useCallback((val: string) => {
    const newSpeed = Number.parseFloat(val)
    setSpeed(newSpeed)
    speedRef.current = newSpeed
    if (playingRef.current) {
      const cast = castRef.current
      if (!cast)
        return
      stopPlayback()
      const currentTime = castTimeRef.current
      const idx = cast.events.findIndex(e => e[0] > currentTime)
      eventIdxRef.current = idx === -1 ? cast.events.length : idx
      playingRef.current = true
      setUiPlaying(true)
      schedulePlayback()
    }
  }, [stopPlayback, schedulePlayback])

  if (parseError != null) {
    return <div className="text-destructive text-sm p-4">{parseError}</div>
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Terminal viewport */}
      <div className="rounded-md overflow-hidden border border-border bg-[#0d1117]">
        <div ref={containerRef} />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={uiPlaying ? pause : play}
          title={uiPlaying ? 'Pause' : 'Play'}
        >
          {uiPlaying ? <Pause /> : <Play />}
        </Button>

        <Button variant="ghost" size="icon-sm" onClick={reset} title="Reset">
          <RotateCcw />
        </Button>

        <span className="text-xs tabular-nums text-muted-foreground min-w-[72px]">
          {formatTime(uiTime)}
          {' / '}
          {formatTime(uiDuration)}
        </span>

        <input
          type="range"
          className="flex-1 h-1.5 cursor-pointer accent-primary"
          min={0}
          max={uiDuration || 1}
          step={0.1}
          value={uiTime}
          onChange={e => handleSeek(Number.parseFloat(e.target.value))}
        />

        <Select value={String(speed)} onValueChange={v => v !== null && handleSpeedChange(v)}>
          <SelectTrigger className="w-[4.5rem] h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEEDS.map(s => (
              <SelectItem key={s} value={String(s)} className="text-xs">
                {s}
                x
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
