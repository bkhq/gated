import type { ApiError } from '@/shared/lib/api/http'
import { AlertOctagon, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { dbRetryAfterSeconds } from '@/shared/lib/api/db-console'
import { Button } from '@/shared/ui/button'

export interface ConsoleErrorBannerProps {
  error: ApiError | null
  targetReadonly?: boolean
  onDismiss: () => void
}

export function ConsoleErrorBanner({ error, targetReadonly, onDismiss }: ConsoleErrorBannerProps) {
  const { t } = useTranslation()
  if (!error)
    return null
  const copy = errorCopy(error, !!targetReadonly, t)
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-[12.5px] text-[hsl(var(--destructive))]"
    >
      <AlertOctagon size={14} className="mt-0.5 shrink-0" />
      <div className="flex-1 leading-snug">{copy}</div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onDismiss}
        aria-label={t('sqlConsole.error.dismiss')}
        className="text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.14)]"
      >
        <X size={12} />
      </Button>
    </div>
  )
}

function errorCopy(
  error: ApiError,
  targetReadonly: boolean,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (error.status) {
    case 401:
      return t('sqlConsole.error.unauthorized')
    case 403:
      return targetReadonly
        ? t('sqlConsole.error.readonly', { message: error.message })
        : t('sqlConsole.error.forbidden', { message: error.message })
    case 404:
      return t('sqlConsole.error.notFound', { message: error.message })
    case 429: {
      const seconds = dbRetryAfterSeconds(error)
      return seconds == null
        ? t('sqlConsole.error.rateLimitedNoHint')
        : t('sqlConsole.error.rateLimited', { seconds })
    }
    case 502:
      return t('sqlConsole.error.upstream', { message: error.message })
    default:
      return t('sqlConsole.error.generic', { message: error.message })
  }
}
