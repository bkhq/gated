import { useTranslation } from 'react-i18next'
import { Outlet } from 'react-router'
import { ModeToggle } from '@/shared/components/mode-toggle'

export function GatewayLayout() {
  const { t } = useTranslation(['gateway', 'common'])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <a href="/@gated" className="text-xl font-heading font-semibold">
          {t('common:appName')}
        </a>
        <nav className="flex items-center gap-4">
          <ModeToggle />
        </nav>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
