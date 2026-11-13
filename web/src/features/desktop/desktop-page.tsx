import { useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TargetAccountGate } from '@/features/targets/components/target-account-gate'
import { Button } from '@/shared/ui/button'
import { useAppStore } from '@/store/app-store'
import { DesktopScreen } from './desktop-screen'

export function DesktopPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { targetName } = useParams({ from: '/desktop/$targetName' })
  const setFullscreen = useAppStore(state => state.setTerminalFullscreen)

  // The desktop owns the viewport, like the terminal: no app shell sidebar.
  React.useEffect(() => {
    setFullscreen(true)
    return () => {
      setFullscreen(false)
    }
  }, [setFullscreen])

  const handleBack = React.useCallback(() => {
    if (window.history.length > 1)
      window.history.back()
    else
      void navigate({ to: '/targets' })
  }, [navigate])

  return (
    <section
      aria-label={t('a11y.desktop.workspace')}
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex flex-none items-center gap-2 border-b border-border bg-card px-4 py-2">
        <Button type="button" variant="ghost" size="icon-sm" onClick={handleBack} aria-label={t('actions.back')}>
          <ArrowLeft size={16} />
        </Button>
        <h1 className="truncate text-sm font-semibold text-foreground">
          {t('desktop.title', { name: targetName })}
        </h1>
        <div className="ml-auto">
          <Button type="button" variant="ghost" size="sm" onClick={handleBack}>
            <X size={14} />
            <span>{t('desktop.actions.disconnect')}</span>
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <TargetAccountGate targetName={targetName}>
          {account => <DesktopScreen targetName={targetName} account={account} />}
        </TargetAccountGate>
      </div>
    </section>
  )
}
