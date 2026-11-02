import { AlertTriangle } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BrandHero } from '@/shared/components/gated-logo'
import { useSiteTitle } from '@/shared/hooks/use-site-title'

/**
 * Centred pre-auth shell used by every encryption boot-gate screen. Visually
 * mirrors the login page so the lock/init step doesn't look like a different
 * application.
 */
export function LockShell({ children, title, description }: {
  children: React.ReactNode
  title: string
  description?: string
}) {
  const { t } = useTranslation()
  const siteTitle = useSiteTitle()
  return (
    <main aria-label={t('a11y.encryption.mainLandmark')} className="flex min-h-screen items-center justify-center bg-background px-5 py-8">
      <div className="w-full max-w-[360px]">
        <BrandHero title={siteTitle} className="mb-8" />
        <h1 className="mb-1 text-[16px] font-semibold text-foreground">{title}</h1>
        {description
          ? <p className="m-0 mb-4 text-[13px] text-muted-foreground">{description}</p>
          : <div className="mb-4" />}
        {children}
      </div>
    </main>
  )
}

export function LockErrorBanner({ id, message }: { id: string, message: string }) {
  return (
    <div id={id} role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-2.5 py-2 text-[12px] text-destructive">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}
