import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { LockShell } from './lock-shell'

/**
 * Rendered when the gateway reports `status: "error"` from /lock-status, or
 * when the polling query itself failed. Lets the operator manually retry the
 * lock-status fetch — `useLockStatus` polls every 3s while in this state, so
 * the screen will also self-clear once the gateway recovers.
 */
export function LockErrorPage({ onRetry, retrying }: {
  onRetry: () => void
  retrying: boolean
}) {
  const { t } = useTranslation()
  return (
    <LockShell title={t('encryption.error.title')} description={t('encryption.error.description')}>
      <Button onClick={onRetry} disabled={retrying} className="w-full">
        {retrying
          ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                <span>{t('encryption.error.retrying')}</span>
              </>
            )
          : t('encryption.error.retry')}
      </Button>
    </LockShell>
  )
}

export function LockPendingPage() {
  const { t } = useTranslation()
  return (
    <LockShell title={t('encryption.pending.title')}>
      <div className="flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        <span>{t('encryption.pending.label')}</span>
      </div>
    </LockShell>
  )
}
