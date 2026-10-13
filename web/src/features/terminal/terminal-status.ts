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
 * Map the hook's `readyState` + last status payload to a banner status. The
 * server's terminal frames (`closed`/`error`/`rate_limited`) win over the
 * WebSocket `readyState` so the failure reason isn't masked by the close
 * that follows.
 */
export function deriveBannerStatus(
  readyState: 'connecting' | 'open' | 'closed',
  lastStatus: StatusPayload | null,
): BannerStatus {
  if (lastStatus !== null && isKnownBannerStatus(lastStatus.status))
    return lastStatus.status
  if (readyState === 'open')
    return 'connected'
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
