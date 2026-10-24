import * as React from 'react'
import { cn } from '@/shared/lib/utils'

export interface TerminalWatermarkProps {
  // Render the overlay only when true. When false the component renders
  // nothing, so callers can mount it unconditionally.
  enabled: boolean
  // Operator identity shown in each tile. `null` falls back to a placeholder.
  username: string | null
  className?: string
}

// How many tiles to render. A generous fixed count fills large viewports; any
// overflow is clipped by `overflow-hidden`. Cheap — these are static spans.
const TILE_COUNT = 96

// Minute-granularity refresh: the watermark timestamp only needs to track wall
// clock coarsely, and re-rendering ~100 tiles every second would be wasteful.
const REFRESH_MS = 60_000

function formatTimestamp(date: Date): string {
  // Local time, minute precision — enough to trace a screenshot to a window.
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Frontend-only watermark overlay for the web terminal. Renders a tiled,
 * low-opacity, non-interactive layer of `<username> · <timestamp>` labels on
 * top of the xterm container.
 *
 * This is a pure DOM/CSS overlay — it never writes bytes into the terminal
 * stream, so PTY rendering is untouched.
 */
export function TerminalWatermark({ enabled, username, className }: TerminalWatermarkProps) {
  const [now, setNow] = React.useState(() => new Date())

  React.useEffect(() => {
    if (!enabled)
      return undefined
    const timer = setInterval(() => setNow(new Date()), REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled])

  if (!enabled)
    return null

  const label = `${username ?? 'unknown'} · ${formatTimestamp(now)}`

  return (
    <div
      aria-hidden="true"
      data-testid="terminal-watermark"
      className={cn(
        'pointer-events-none absolute inset-0 z-10 flex flex-wrap content-start items-start gap-x-16 gap-y-10 overflow-hidden p-4 select-none',
        className,
      )}
    >
      {Array.from({ length: TILE_COUNT }, (_, i) => (
        <span
          key={i}
          className="rotate-[-24deg] font-mono text-xs whitespace-nowrap text-foreground/[0.06]"
        >
          {label}
        </span>
      ))}
    </div>
  )
}
