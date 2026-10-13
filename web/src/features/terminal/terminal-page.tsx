import type { StatusPayload, TerminalKind } from './codec'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/shared/components/empty-state'
import { Button } from '@/shared/ui/button'
import { useAppStore } from '@/store/app-store'
import { TerminalScreen } from './terminal-screen'

const KINDS: readonly TerminalKind[] = ['ssh', 'mysql', 'postgres']

function isTerminalKind(value: string): value is TerminalKind {
  return (KINDS as readonly string[]).includes(value)
}

export function TerminalPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { kind, targetName } = useParams({ from: '/terminal/$kind/$targetName' })
  const setFullscreen = useAppStore(state => state.setTerminalFullscreen)

  // Terminal owns the viewport: hide the app shell sidebar while mounted and
  // restore it on unmount.
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

  const handleSessionEnd = React.useCallback((_payload: StatusPayload) => {
    // Surface termination via the banner inside TerminalScreen. The route
    // intentionally does NOT auto-navigate so the user can read the cause
    // (closed / error / rate_limited) and choose to retry or back out.
  }, [])

  if (!isTerminalKind(kind)) {
    return (
      <section
        aria-label={t('a11y.terminal.workspace')}
        className="flex h-full min-h-0 flex-col"
      >
        <header className="flex items-center gap-2 border-b border-border bg-card px-4 py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={handleBack}
            aria-label={t('actions.back')}
          >
            <ArrowLeft size={16} />
          </Button>
          <h1 className="truncate text-sm font-semibold text-foreground">
            {t('terminal.title.unsupported')}
          </h1>
        </header>
        <div className="flex-1 p-10">
          <EmptyState
            title={t('terminal.unsupported.title')}
            description={t('terminal.unsupported.description', { kind })}
          />
        </div>
      </section>
    )
  }

  const titleByKind: Record<TerminalKind, string> = {
    ssh: t('terminal.title.ssh', { name: targetName }),
    mysql: t('terminal.title.mysql', { name: targetName }),
    postgres: t('terminal.title.postgres', { name: targetName }),
  }

  const bannerLabels = {
    connecting: t('terminal.status.connecting'),
    connected: t('terminal.status.connected'),
    closed: t('terminal.status.closed'),
    error: t('terminal.status.error'),
    rate_limited: t('terminal.status.rateLimited'),
    info: t('terminal.status.info'),
  }

  const hostKeyLabels = {
    title: t('terminal.hostKey.title'),
    description: t('terminal.hostKey.description'),
    algorithmLabel: t('terminal.hostKey.algorithm'),
    fingerprintLabel: t('terminal.hostKey.fingerprint'),
    countdown: t('terminal.hostKey.countdown'),
    accept: t('terminal.hostKey.accept'),
    reject: t('terminal.hostKey.reject'),
  }

  return (
    <section
      aria-label={t('a11y.terminal.workspace')}
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex flex-none items-center gap-2 border-b border-border bg-card px-4 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleBack}
          aria-label={t('actions.back')}
        >
          <ArrowLeft size={16} />
        </Button>
        <h1 className="truncate text-sm font-semibold text-foreground">
          {titleByKind[kind]}
        </h1>
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleBack}
            aria-label={t('terminal.actions.disconnect')}
          >
            <X size={14} />
            <span>{t('terminal.actions.disconnect')}</span>
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 p-2">
        <TerminalScreen
          kind={kind}
          targetName={targetName}
          bannerLabels={bannerLabels}
          hostKeyLabels={hostKeyLabels}
          onSessionEnd={handleSessionEnd}
          className="flex-1"
        />
      </div>
    </section>
  )
}
