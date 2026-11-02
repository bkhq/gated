import type { ErrorComponentProps } from '@tanstack/react-router'
import { Link, useRouter } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'

/** Branded replacement for TanStack Router's default error boundary UI. */
export function RouteError({ error, reset }: Pick<ErrorComponentProps, 'error' | 'reset'>) {
  const { t } = useTranslation()
  const router = useRouter()
  const message = error instanceof Error ? error.message : String(error)

  return (
    <div role="alert" className="mx-auto flex w-full max-w-lg flex-col items-center gap-3 px-6 py-16 text-center">
      <div aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-destructive">
        <AlertTriangle size={18} />
      </div>
      <h1 className="text-base font-semibold text-foreground">{t('states.routeError.title')}</h1>
      <p className="text-[13px] text-muted-foreground">{t('states.routeError.description')}</p>
      {message
        ? (
            <pre className="max-h-40 w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-left font-mono text-xs text-muted-foreground">
              {message}
            </pre>
          )
        : null}
      <div className="mt-1 flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            reset()
            void router.invalidate()
          }}
        >
          {t('states.routeError.retry')}
        </Button>
        <Link to="/" className="inline-flex h-[30px] items-center rounded-md border border-border px-2.5 text-[13px] font-medium text-foreground hover:bg-accent">
          {t('states.routeError.home')}
        </Link>
      </div>
    </div>
  )
}
