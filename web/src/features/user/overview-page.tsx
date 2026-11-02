import type { LucideIcon } from 'lucide-react'
import type { Target } from '@/shared/types/domain'
import { Link, useNavigate } from '@tanstack/react-router'
import { Activity, ChevronRight, Inbox, ServerCog, Ticket } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthRequests } from '@/features/auth-requests/hooks/use-auth-requests-queries'
import { useRecentActivity } from '@/features/recent-activity/hooks/use-recent-activity-queries'
import { useMyLiveSessions } from '@/features/sessions/hooks/use-sessions-queries'
import { TargetKindIcon } from '@/features/targets/components/target-kind-icon'
import { useFrequentTargets, useTargets } from '@/features/targets/hooks/use-targets-queries'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { useMyTickets } from '@/features/tickets/hooks/use-tickets-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { TimeText } from '@/shared/components/time-text'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Skeleton } from '@/shared/ui/skeleton'
import { useAppStore } from '@/store/app-store'

type StatTone = 'neutral' | 'info' | 'warning' | 'mono'

const TONE_ICON_CLASS: Record<StatTone, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-[hsl(var(--info))]',
  warning: 'text-[hsl(var(--warning))]',
  mono: 'text-muted-foreground',
}

const TONE_VALUE_CLASS: Record<StatTone, string> = {
  neutral: 'text-foreground',
  info: 'text-foreground',
  warning: 'text-[hsl(var(--warning))]',
  mono: 'text-foreground',
}

interface OverviewStatProps {
  label: string
  value: string | number
  hint?: string
  icon: LucideIcon
  tone?: StatTone
  onClick: () => void
  ariaLabel?: string
}

function OverviewStat({ label, value, hint, icon: Icon, tone = 'neutral', onClick, ariaLabel }: OverviewStatProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `${label}: ${value}`}
      className="focus-ring group flex min-w-0 flex-col items-stretch gap-2 rounded-lg border border-border bg-card p-3 text-left sm:p-5 text-card-foreground transition duration-150 ease-out hover:border-[hsl(var(--ring)/0.55)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.04)] active:translate-y-px"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 truncate text-[12px] font-medium text-muted-foreground">{label}</div>
        <Icon size={15} className={`shrink-0 ${TONE_ICON_CLASS[tone]}`} aria-hidden="true" />
      </div>
      <div className={`tabular mt-1 text-[20px] font-semibold sm:text-[24px] tracking-normal ${TONE_VALUE_CLASS[tone]}`}>{value}</div>
      {hint ? <div className="truncate text-[12px] text-muted-foreground">{hint}</div> : null}
    </button>
  )
}

function StatRowSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_unused, i) => (
        <Skeleton key={`stat-skeleton-${String(i)}`} className="h-[92px] sm:h-[112px]" />
      ))}
    </div>
  )
}

function FrequentTargetsCardSkeleton({ label }: { label: string }) {
  return (
    <Card role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      <CardHeader>
        <div className="min-w-0">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-2 h-3 w-56" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        {Array.from({ length: 5 }, (_unused, i) => (
          <Skeleton key={`freq-skel-${String(i)}`} className="h-12 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

function RecentActivityCardSkeleton({ label }: { label: string }) {
  return (
    <Card role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      <CardHeader>
        <div className="min-w-0">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="mt-2 h-3 w-44" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 4 }, (_unused, i) => (
          <div key={`rec-skel-${String(i)}`} className="flex items-start gap-2.5">
            <Skeleton className="h-7 w-7 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-44" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function withinNextMs(iso: string, windowMs: number, now: number = Date.now()): boolean {
  const ms = new Date(iso).getTime() - now
  return Number.isFinite(ms) && ms > 0 && ms <= windowMs
}

export function OverviewPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const identity = useAppStore(state => state.identity)
  const firstName = identity.name.split(' ')[0] ?? identity.name

  const targetsQuery = useTargets()
  const liveSessionsQuery = useMyLiveSessions()
  const authRequestsQuery = useAuthRequests()
  const myTicketsQuery = useMyTickets(identity.username)
  const frequentTargetsQuery = useFrequentTargets(5)
  const recentActivityQuery = useRecentActivity(identity.username)

  const targets = targetsQuery.data ?? []

  const liveSessions = liveSessionsQuery.data ?? []
  const liveSessionCount = liveSessions.length

  const pendingApprovalCount = (authRequestsQuery.data ?? []).filter(item => item.state === 'pending').length

  const myTickets = myTicketsQuery.data ?? []
  const myTicketCount = myTickets.length
  const ticketsExpiringSoon = myTickets.filter(item => withinNextMs(item.expiresAt, 24 * 60 * 60 * 1000)).length

  const frequentTargets = frequentTargetsQuery.data ?? []
  const recentActivity = recentActivityQuery.data ?? []

  const statsLoading = targetsQuery.isLoading || liveSessionsQuery.isLoading || authRequestsQuery.isLoading || myTicketsQuery.isLoading
  const frequentLoading = frequentTargetsQuery.isLoading
  const recentLoading = recentActivityQuery.isLoading

  const openTarget = (target: Target) => {
    void navigate({ to: '/targets/$targetId', params: { targetId: target.id } })
  }

  return (
    <>
      <PageHeader
        title={t('overview.welcome.greeting', { firstName })}
        description={t('overview.welcome.description')}
      />

      <div className="flex flex-col gap-4 p-4 sm:p-6">
        {statsLoading
          ? <StatRowSkeleton label={t('a11y.overview.statsLoading')} />
          : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <OverviewStat
                  label={t('overview.stats.reachableTargets')}
                  value={targets.length}
                  icon={ServerCog}
                  onClick={() => { void navigate({ to: '/targets' }) }}
                />
                <OverviewStat
                  label={t('overview.stats.activeSessions')}
                  value={liveSessionCount}
                  hint={liveSessionCount > 0 ? t('overview.stats.recording') : t('overview.stats.sessionsIdle')}
                  icon={Activity}
                  tone="info"
                  onClick={() => { void navigate({ to: '/sessions' }) }}
                />
                <OverviewStat
                  label={t('overview.stats.pendingApprovals')}
                  value={pendingApprovalCount}
                  hint={pendingApprovalCount > 0 ? t('overview.stats.awaiting') : t('overview.stats.pendingNone')}
                  icon={Inbox}
                  tone="warning"
                  onClick={() => { void navigate({ to: '/auth-requests' }) }}
                />
                <OverviewStat
                  label={t('overview.stats.myTickets')}
                  value={myTicketCount}
                  hint={ticketsExpiringSoon > 0
                    ? t('overview.stats.ticketsExpiring', { count: ticketsExpiringSoon })
                    : t('overview.stats.ticketsClean')}
                  icon={Ticket}
                  tone="mono"
                  onClick={() => { void navigate({ to: '/tickets' }) }}
                />
              </div>
            )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
          {frequentLoading
            ? <FrequentTargetsCardSkeleton label={t('a11y.overview.frequentLoading')} />
            : (
                <Card>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{t('overview.frequentTargets.title')}</CardTitle>
                      <CardDescription>{t('overview.frequentTargets.description')}</CardDescription>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { void navigate({ to: '/targets' }) }}
                    >
                      <span>{t('overview.frequentTargets.viewAll')}</span>
                      <ChevronRight size={12} aria-hidden="true" />
                    </Button>
                  </CardHeader>
                  <CardContent className="px-2 pb-2">
                    {frequentTargets.length === 0
                      ? (
                          <div className="px-3 pb-3 pt-1">
                            <EmptyState
                              icon={ServerCog}
                              title={t('overview.frequentTargets.empty')}
                              description={t('overview.frequentTargets.emptyDescription')}
                            />
                          </div>
                        )
                      : (
                          <ul className="m-0 flex flex-col p-0">
                            {frequentTargets.map(target => (
                              <li key={target.id} className="list-none">
                                <button
                                  type="button"
                                  onClick={() => openTarget(target)}
                                  aria-label={t('a11y.overview.openTargetButton', { name: target.name })}
                                  className="focus-ring flex w-full min-w-0 items-center gap-3 rounded-md border-none bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent"
                                >
                                  <TargetKindIcon kind={target.kind} size={32} />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13.5px] font-medium text-foreground">{target.name}</div>
                                    <div className="mono truncate text-[12px] text-muted-foreground">
                                      {formatTargetAddress(target)}
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <Badge tone="mono">{target.kind.toUpperCase()}</Badge>
                                    <ChevronRight size={14} className="text-muted-foreground/60" aria-hidden="true" />
                                  </div>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                  </CardContent>
                </Card>
              )}

          {recentLoading
            ? <RecentActivityCardSkeleton label={t('a11y.overview.recentLoading')} />
            : (
                <Card>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{t('overview.recentActivity.title')}</CardTitle>
                      <CardDescription>{t('overview.recentActivity.description')}</CardDescription>
                    </div>
                    <Link
                      to="/admin/audit"
                      className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      <span>{t('overview.recentActivity.viewAll')}</span>
                      <ChevronRight size={12} aria-hidden="true" />
                    </Link>
                  </CardHeader>
                  <CardContent>
                    {recentActivity.length === 0
                      ? (
                          <EmptyState
                            icon={Activity}
                            title={t('overview.recentActivity.empty')}
                            description={t('overview.recentActivity.emptyDescription')}
                          />
                        )
                      : (
                          <ul className="m-0 flex flex-col gap-3.5 p-0">
                            {recentActivity.map(entry => (
                              <li key={entry.id} data-testid="recent-activity-row" className="flex list-none items-start gap-2.5">
                                <span
                                  aria-hidden="true"
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
                                >
                                  <Activity size={13} />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 items-baseline gap-2">
                                    <span className="truncate text-[13px] font-medium text-foreground">
                                      {entry.target ? `${entry.user} · ${entry.target}` : entry.user}
                                    </span>
                                    <TimeText iso={entry.latest} mode="relative" className="ml-auto shrink-0 text-[12px] text-muted-foreground" />
                                  </div>
                                  <div className="truncate text-[12.5px] text-muted-foreground">
                                    {entry.events
                                      .map(event => event.count > 1
                                        ? t('overview.recentActivity.eventCount', { label: t(event.key), count: event.count })
                                        : t(event.key))
                                      .join(' · ')}
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                  </CardContent>
                </Card>
              )}
        </div>
      </div>
    </>
  )
}
