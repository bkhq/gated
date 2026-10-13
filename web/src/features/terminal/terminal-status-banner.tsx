import type { BannerLabels, BannerStatus } from './terminal-status'
import { cn } from '@/shared/lib/utils'

const DEFAULT_LABELS: BannerLabels = {
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Session closed',
  error: 'Session error',
  rate_limited: 'Rate limit reached',
  info: 'Info',
}

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'muted'

const TONE_BY_STATUS: Record<BannerStatus, Tone> = {
  connecting: 'info',
  connected: 'success',
  closed: 'muted',
  error: 'danger',
  rate_limited: 'warning',
  info: 'info',
}

const TONE_CLASS: Record<Tone, string> = {
  info: 'bg-[hsl(var(--info)/0.12)] text-[hsl(var(--info))] border-[hsl(var(--info)/0.3)]',
  success: 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.3)]',
  warning: 'bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.3)]',
  danger: 'bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))] border-[hsl(var(--destructive)/0.3)]',
  muted: 'bg-muted text-muted-foreground border-border',
}

const DOT_CLASS: Record<Tone, string> = {
  info: 'bg-[hsl(var(--info))]',
  success: 'bg-[hsl(var(--success))]',
  warning: 'bg-[hsl(var(--warning))]',
  danger: 'bg-[hsl(var(--destructive))]',
  muted: 'bg-muted-foreground',
}

export interface TerminalStatusBannerProps {
  status: BannerStatus
  // Optional server-supplied message (status frame `.message`). Shown after the
  // status label so failures from the gateway surface verbatim.
  message?: string
  labels?: Partial<BannerLabels>
  className?: string
}

export function TerminalStatusBanner({
  status,
  message,
  labels,
  className,
}: TerminalStatusBannerProps) {
  const tone = TONE_BY_STATUS[status]
  const merged: BannerLabels = { ...DEFAULT_LABELS, ...labels }
  const label = merged[status]
  const pulse = status === 'connecting'

  return (
    <div
      role="status"
      aria-live="polite"
      data-status={status}
      data-tone={tone}
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-2 w-2 shrink-0 rounded-full',
          DOT_CLASS[tone],
          pulse && 'pulse-dot',
        )}
      />
      <span className="font-medium">{label}</span>
      {message
        ? (
            <span className="min-w-0 truncate text-muted-foreground" title={message}>
              {message}
            </span>
          )
        : null}
    </div>
  )
}
