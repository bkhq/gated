import type { StatusPayload } from './codec'

// Server-emitted status values (api.md §1.8 / §6.10) plus the client-side
// "connecting" phase the hook exposes before the first server frame lands.
// "info" is SSH-only; my/pg never send it.
export type BannerStatus
  = | 'connecting'
    | 'connected'
    | 'closed'
    | 'error'
    | 'rate_limited'
    | 'info'

export interface BannerLabels {
  connecting: string
  connected: string
  closed: string
  error: string
  rate_limited: string
  info: string
}

/**
 * Map the last status payload to a banner status. Until the server reports
 * `connected` the session is still connecting: the WebSocket opens before the
 * gateway has signed in to the target, and that sign-in may still fail.
 */
export function deriveBannerStatus(lastStatus: StatusPayload | null): BannerStatus {
  if (lastStatus !== null && isKnownBannerStatus(lastStatus.status))
    return lastStatus.status
  return 'connecting'
}

function isKnownBannerStatus(value: string): value is BannerStatus {
  return (
    value === 'connecting'
    || value === 'connected'
    || value === 'closed'
    || value === 'error'
    || value === 'rate_limited'
    || value === 'info'
  )
}

// Session tab dot colour for a connection status; SQL and file sessions
// report none.
export function statusDotClass(status: BannerStatus | undefined): string {
  switch (status) {
    case 'connected':
      return 'bg-[hsl(var(--success))]'
    case 'error':
    case 'rate_limited':
      return 'bg-destructive'
    case 'connecting':
    case 'closed':
    case 'info':
    case undefined:
      return 'bg-muted-foreground/40'
  }
}

export type ProgressTone = 'progress' | 'ended' | 'failed'

/** A gateway line written into the terminal, styled apart from session output. */
export function progressLine(text: string, tone: ProgressTone): string {
  const color = tone === 'failed' ? '31' : tone === 'ended' ? '33' : '2'
  const clean = text.replace(/[\r\n]+/g, ' ')
  // An end line starts on a fresh line after whatever the session printed.
  const lead = tone === 'progress' ? '' : '\r\n'
  return `${lead}\x1B[${color}m${clean}\x1B[0m\r\n`
}
