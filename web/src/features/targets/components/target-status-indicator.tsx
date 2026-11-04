import type { TargetHealth } from '@/shared/types/domain'
import { useTranslation } from 'react-i18next'
import { StatusDot } from '@/shared/components/status-dot'

/** Last reachability check: green with latency, red when down, grey when never checked. */
export function TargetStatusIndicator({ status }: { status: TargetHealth | null | undefined }) {
  const { t } = useTranslation()
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <StatusDot tone="muted" />
        <span>{t('targets.status.unknown')}</span>
      </span>
    )
  }
  const checkedAt = new Date(status.checkedAt).toLocaleString()
  const title = status.reachable
    ? t('targets.status.checkedAt', { time: checkedAt })
    : `${status.error ?? t('targets.status.down')} · ${t('targets.status.checkedAt', { time: checkedAt })}`
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground" title={title}>
      <StatusDot tone={status.reachable ? 'success' : 'danger'} />
      <span className={status.reachable ? undefined : 'text-destructive'}>
        {status.reachable
          ? t('targets.status.upLatency', { ms: status.latencyMs ?? 0 })
          : t('targets.status.down')}
      </span>
    </span>
  )
}
