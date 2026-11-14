import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { checkSession } from '@/shared/lib/api/auth'
import { formatCountdown } from './format-countdown'

/**
 * How long the browser session stays signed in without further activity.
 * Asks the gateway once when shown, which does not extend the session, and
 * counts down from there.
 */
export function SessionCountdown() {
  const { t } = useTranslation()
  const status = useQuery({
    queryKey: ['session-status'],
    queryFn: async ({ signal }) => checkSession(signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (!status.data)
    return null
  const left = status.data.expires_in - (now - status.dataUpdatedAt) / 1000
  return (
    <div className="truncate text-[11px] tabular-nums text-muted-foreground">
      {t('menu.sessionExpiresIn', { time: formatCountdown(Math.ceil(left)) })}
    </div>
  )
}
