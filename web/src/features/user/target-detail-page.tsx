import type { TerminalKind } from '@/features/terminal/codec'
import type { LiveSession, Target } from '@/shared/types/domain'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useMySessionsForTarget } from '@/features/sessions/hooks/use-sessions-queries'
import { TargetDetailHeader, TargetDetailTabsBody, useTargetDetailTabs } from '@/features/targets/components'
import { useTarget } from '@/features/targets/hooks/use-targets-queries'
import { buildConnectCommand } from '@/features/targets/lib/connect-command'
import { EmptyState } from '@/shared/components/empty-state'
import { useInfo, useIsAdmin } from '@/shared/hooks/use-info'
import { useAppStore } from '@/store/app-store'

const route = getRouteApi('/targets/$targetId')

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function TargetDetailPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { targetId } = route.useParams()
  const targetQuery = useTarget(targetId)
  const target = targetQuery.data

  const sessionsQuery = useMySessionsForTarget(target?.name)
  const mySessions: LiveSession[] = React.useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data])
  const tabs = useTargetDetailTabs(mySessions.length, target ?? undefined, 'user')

  const [favorite, setFavorite] = React.useState(false)
  const lastUpdatedAt = sessionsQuery.dataUpdatedAt || targetQuery.dataUpdatedAt
  const lastUpdated = React.useMemo(
    () => (lastUpdatedAt ? formatClockTime(new Date(lastUpdatedAt)) : ''),
    [lastUpdatedAt],
  )

  const handleRefresh = React.useCallback(() => {
    void targetQuery.refetch()
    void sessionsQuery.refetch()
  }, [targetQuery, sessionsQuery])

  const info = useInfo().data
  const openTerminalTab = useAppStore(state => state.openTerminalTab)

  // Only ssh/mysql/postgres have an in-browser terminal client (api.md §1.8).
  // HTTP targets are reached through the HTTP proxy listener, so the Connect
  // button is hidden for them (handleConnect stays undefined).
  const isTerminalKind = target && (target.kind === 'ssh' || target.kind === 'mysql' || target.kind === 'postgres')
  const handleConnect = React.useMemo(() => {
    if (!target || !isTerminalKind)
      return undefined
    return () => {
      openTerminalTab({ type: 'terminal', kind: target.kind as TerminalKind, targetId: target.id, targetName: target.name })
      void navigate({ to: '/sessions' })
    }
  }, [target, isTerminalKind, openTerminalTab, navigate])

  const handleCopyConnect = React.useCallback(() => {
    if (!target)
      return
    const cmd = buildConnectCommand(target, info) ?? target.name
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(cmd).catch(() => {})
    }
  }, [target, info])

  const lastClosedSession = React.useMemo(
    () => mySessions.find(session => session.state === 'closed'),
    [mySessions],
  )

  // Session details and recordings are served by the admin API only, so the
  // per-session actions exist for admins and open that session by id.
  const isAdmin = useIsAdmin()
  const openSession = React.useCallback((session: LiveSession) => {
    void navigate({ to: '/admin/sessions/$sessionId', params: { sessionId: session.id } })
  }, [navigate])
  const sessionAction = isAdmin ? openSession : undefined

  const handleReplayLast = React.useCallback(() => {
    if (lastClosedSession)
      openSession(lastClosedSession)
  }, [lastClosedSession, openSession])

  const handleOpenSqlConsole = React.useCallback((item: Target) => {
    openTerminalTab({ type: 'sql', kind: item.kind as TerminalKind, targetId: item.id, targetName: item.name })
    void navigate({ to: '/sessions' })
  }, [openTerminalTab, navigate])

  const handleOpenFiles = React.useCallback((item: Target) => {
    openTerminalTab({ type: 'files', kind: 'ssh', targetId: item.id, targetName: item.name })
    void navigate({ to: '/sessions' })
  }, [openTerminalTab, navigate])

  if (targetQuery.isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t('a11y.targetDetail.loading')}
        className="p-6 text-sm text-muted-foreground"
      >
        {t('targets.detail.loading')}
      </div>
    )
  }
  if (targetQuery.isError) {
    return (
      <div className="p-10">
        <EmptyState
          title={t('targets.detail.errorTitle')}
          description={t('targets.detail.errorDescription')}
        />
      </div>
    )
  }
  if (!target) {
    return (
      <div className="p-10">
        <EmptyState title={t('targets.detail.notFoundTitle')} description={t('targets.detail.notFoundDescription')} />
      </div>
    )
  }

  return (
    <>
      <TargetDetailHeader
        target={target}
        mode="user"
        breadcrumbs={[
          { label: t('nav.targets'), to: '/targets' },
          { label: target.name },
        ]}
        tabs={tabs.list}
        lastUpdated={lastUpdated}
        refreshing={targetQuery.isFetching || sessionsQuery.isFetching}
        favorite={favorite}
        replayLastDisabled={!lastClosedSession}
        onRefresh={handleRefresh}
        onToggleFavorite={setFavorite}
        onReplayLast={isAdmin ? handleReplayLast : undefined}
        onConnect={handleConnect}
        onCopyConnect={handleCopyConnect}
        onOpenSqlConsole={handleOpenSqlConsole}
        onOpenFiles={handleOpenFiles}
      />
      <div className="px-6 pb-6 pt-4">
        <TargetDetailTabsBody
          target={target}
          mode="user"
          mySessions={mySessions}
          tabsValue={tabs.value}
          onTabsChange={tabs.onChange}
          onOpenSession={sessionAction}
          onReplaySession={sessionAction}
        />
      </div>
    </>
  )
}
