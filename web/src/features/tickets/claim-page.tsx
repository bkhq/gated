import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BrandHero } from '@/shared/components/gated-logo'
import { useSiteTitle } from '@/shared/hooks/use-site-title'
import { ApiError } from '@/shared/lib/api/http'
import { claimTicket } from '@/shared/lib/api/tickets'
import { claimDestination, secretFromHash } from './lib/handoff'

/**
 * `/ui/ticket#<secret>`: signs the browser in with the ticket and opens its
 * target. No login, no button: the recipient has no account.
 */
export function ClaimPage() {
  const { t } = useTranslation()
  const siteTitle = useSiteTitle()
  const [secret] = React.useState(() => secretFromHash(window.location.hash))
  const [error, setError] = React.useState<string | null>(secret ? null : 'tickets.claim.missing')

  React.useEffect(() => {
    // The secret leaves the address bar and history right away.
    window.history.replaceState(null, '', window.location.pathname)
    if (!secret)
      return undefined
    let cancelled = false
    claimTicket(secret)
      .then((claimed) => {
        if (!cancelled)
          window.location.assign(claimDestination(claimed.kind, claimed.target_name))
      })
      .catch((err: unknown) => {
        if (cancelled)
          return
        const status = err instanceof ApiError ? err.status : 0
        setError(status === 404 ? 'tickets.claim.invalid' : status === 429 ? 'tickets.claim.tooMany' : 'tickets.claim.failed')
      })
    return () => {
      cancelled = true
    }
  }, [secret])

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <BrandHero title={siteTitle} heading />
        {error
          ? <p role="alert" className="mt-5 text-center text-[13.5px] text-destructive">{t(error)}</p>
          : <p role="status" className="mt-5 text-center text-[13.5px] text-muted-foreground">{t('tickets.claim.connecting')}</p>}
      </div>
    </main>
  )
}
