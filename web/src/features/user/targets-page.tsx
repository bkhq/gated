import type { Target } from '@/shared/types/domain'
import { useNavigate } from '@tanstack/react-router'
import { AlertOctagon, ArrowDown, ArrowUp, ArrowUpDown, LayoutGrid, List, Search, ServerCog, Terminal } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useRecentActivity } from '@/features/recent-activity/hooks/use-recent-activity-queries'
import { TargetCard } from '@/features/targets/components'
import { TargetKindIcon } from '@/features/targets/components/target-kind-icon'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { targetGroupLabel, targetGroupOptions } from '@/features/targets/lib/target-group'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { StatCard } from '@/shared/components/stat-card'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { useAppStore } from '@/store/app-store'

type SortKey = 'name' | 'group'
type SortDir = 'asc' | 'desc'

const PROTOCOL_OPTIONS: { value: 'all' | Target['kind'], label?: string, labelKey?: string }[] = [
  { value: 'all', labelKey: 'targets.filters.allProtocols' },
  { value: 'ssh', label: 'SSH' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'http', label: 'HTTP' },
]

function compareTargets(a: Target, b: Target, key: SortKey, dir: SortDir): number {
  let cmp = 0
  switch (key) {
    case 'name':
      cmp = a.name.localeCompare(b.name)
      break
    case 'group':
      cmp = (a.groupName ?? '').localeCompare(b.groupName ?? '')
      break
  }
  if (cmp === 0)
    cmp = a.name.localeCompare(b.name)
  return dir === 'asc' ? cmp : -cmp
}

function SortHeader({ label, active, dir, onClick, ariaLabel }: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  ariaLabel: string
}) {
  const Icon = active ? (dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="focus-ring -mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground transition hover:text-foreground data-active:text-foreground"
      data-active={active || undefined}
    >
      <span>{label}</span>
      <Icon size={11} aria-hidden="true" className={active ? 'text-foreground' : ''} />
    </button>
  )
}

function StatsRowSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label} className="grid gap-3 md:grid-cols-2">
      {Array.from({ length: 2 }, (_unused, i) => (
        <Skeleton key={`targets-stat-skel-${String(i)}`} className="h-[108px]" />
      ))}
    </div>
  )
}

function GridSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
      {Array.from({ length: 6 }, (_unused, i) => (
        <Skeleton key={`targets-card-skel-${String(i)}`} className="h-[148px]" />
      ))}
    </div>
  )
}

export function TargetsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const identity = useAppStore(state => state.identity)

  const targetsQuery = useTargets()
  const recentActivityQuery = useRecentActivity(identity.username)

  const targets = React.useMemo(() => targetsQuery.data ?? [], [targetsQuery.data])
  const recentActivity = React.useMemo(() => recentActivityQuery.data ?? [], [recentActivityQuery.data])

  const [query, setQuery] = React.useState('')
  const [view, setView] = React.useState<'grid' | 'table'>('grid')
  const [kindFilter, setKindFilter] = React.useState<'all' | Target['kind']>('all')
  const [groupFilter, setGroupFilter] = React.useState('all')
  const [sortKey, setSortKey] = React.useState<SortKey>('name')
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')

  const groupOptions = React.useMemo(
    () => targetGroupOptions(targets, t('targets.ungrouped')),
    [targets, t],
  )

  const filtered = React.useMemo(() => {
    const haystackTerm = query.trim().toLowerCase()
    const next = targets.filter((target) => {
      if (kindFilter !== 'all' && target.kind !== kindFilter)
        return false
      if (groupFilter !== 'all' && target.group !== groupFilter)
        return false
      if (haystackTerm) {
        const hay = `${target.name} ${target.host} ${target.user}`.toLowerCase()
        if (!hay.includes(haystackTerm))
          return false
      }
      return true
    })
    next.sort((a, b) => compareTargets(a, b, sortKey, sortDir))
    return next
  }, [targets, kindFilter, groupFilter, query, sortKey, sortDir])

  const recentTargetCount = React.useMemo(() => {
    const seen = new Set<string>()
    for (const entry of recentActivity)
      seen.add(entry.sessionId)
    return seen.size
  }, [recentActivity])

  const hasActiveFilters = kindFilter !== 'all' || groupFilter !== 'all' || query.trim() !== ''

  const clearFilters = React.useCallback(() => {
    setKindFilter('all')
    setGroupFilter('all')
    setQuery('')
  }, [])

  const openDetail = (target: Target) => {
    void navigate({ to: '/targets/$targetId', params: { targetId: target.id } })
  }

  const requestSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    }
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const statsLoading = targetsQuery.isLoading || recentActivityQuery.isLoading
  const isLoading = targetsQuery.isLoading
  const isError = targetsQuery.isError

  return (
    <>
      <PageHeader
        title={t('nav.targets')}
        description={t('targets.userDescription')}
        actions={(
          <div
            role="group"
            aria-label={t('a11y.targets.viewModeGroup')}
            className="inline-flex rounded-md bg-muted p-[3px]"
          >
            {([['grid', LayoutGrid, 'a11y.targets.viewGrid'], ['table', List, 'a11y.targets.viewTable']] as const).map(([mode, Icon, labelKey]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                className={`focus-ring inline-flex h-[30px] w-9 items-center justify-center rounded-sm transition ${view === mode ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]' : 'text-muted-foreground'}`}
                aria-label={t(labelKey)}
                aria-pressed={view === mode}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      />

      <div className="flex flex-col gap-4 px-6 py-4">
        {statsLoading
          ? <StatsRowSkeleton label={t('targets.statsLoading')} />
          : (
              <div className="grid gap-3 md:grid-cols-2">
                <StatCard
                  label={t('targets.stats.reachable')}
                  value={targets.length}
                  hint={t('targets.stats.reachableHint')}
                  icon={ServerCog}
                />
                <StatCard
                  label={t('targets.stats.recentlyUsed')}
                  value={recentTargetCount}
                  hint={recentTargetCount === 0
                    ? t('targets.stats.recentlyUsedHintNone')
                    : t('targets.stats.recentlyUsedHint', { count: recentTargetCount })}
                  icon={Terminal}
                />
              </div>
            )}

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="w-[320px]">
            <Input
              icon={Search}
              placeholder={t('targets.userSearchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label={t('a11y.targets.searchLabel')}
            />
          </div>
          <Select
            className="w-[160px]"
            value={kindFilter}
            onValueChange={value => setKindFilter(value as 'all' | Target['kind'])}
            options={PROTOCOL_OPTIONS.map(option => (option.labelKey
              ? { value: option.value, label: t(option.labelKey) }
              : { value: option.value, label: option.label as string }))}
            aria-label={t('a11y.targets.filterProtocol')}
          />
          <Select
            className="w-[200px]"
            value={groupFilter}
            onValueChange={setGroupFilter}
            options={[
              { value: 'all', label: t('targets.filters.allGroups') },
              ...groupOptions,
            ]}
            aria-label={t('a11y.targets.filterGroup')}
          />
          {hasActiveFilters
            ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  aria-label={t('targets.clearFilters')}
                >
                  {t('actions.clearFilters')}
                </Button>
              )
            : null}
          <span className="flex-1" />
          <span
            role="status"
            aria-live="polite"
            aria-label={t('a11y.targets.resultCount', { filtered: filtered.length, total: targets.length })}
            className="text-[12px] text-muted-foreground"
          >
            {filtered.length}
            {' / '}
            {targets.length}
          </span>
        </div>

        {isError
          ? (
              <EmptyState
                icon={AlertOctagon}
                title={t('targets.error.title')}
                description={t('targets.error.description')}
                action={(
                  <Button size="sm" variant="outline" onClick={() => { void targetsQuery.refetch() }}>
                    {t('targets.error.retry')}
                  </Button>
                )}
              />
            )
          : isLoading
            ? <GridSkeleton label={t('targets.loading')} />
            : targets.length === 0
              ? (
                  <EmptyState
                    icon={ServerCog}
                    title={t('targets.empty.title')}
                    description={t('targets.empty.description')}
                  />
                )
              : filtered.length === 0
                ? (
                    <EmptyState
                      icon={Search}
                      title={t('targets.emptyFiltered.title')}
                      description={t('targets.emptyFiltered.description')}
                      action={(
                        <Button size="sm" variant="outline" onClick={clearFilters}>
                          {t('actions.clearFilters')}
                        </Button>
                      )}
                    />
                  )
                : view === 'grid'
                  ? (
                      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
                        {filtered.map(target => (
                          <TargetCard
                            key={target.id}
                            target={target}
                            mode="user"
                            onOpen={openDetail}
                            onConnect={openDetail}
                          />
                        ))}
                      </div>
                    )
                  : (
                      <Table>
                        <THead>
                          <TR>
                            <TH className="pl-5" aria-sort={sortKey === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                              <SortHeader
                                label={t('fields.name')}
                                active={sortKey === 'name'}
                                dir={sortDir}
                                onClick={() => requestSort('name')}
                                ariaLabel={t('targets.sortBy', { column: t('fields.name') })}
                              />
                            </TH>
                            <TH>{t('fields.type')}</TH>
                            <TH>{t('fields.address')}</TH>
                            <TH aria-sort={sortKey === 'group' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                              <SortHeader
                                label={t('targets.detail.overview.group')}
                                active={sortKey === 'group'}
                                dir={sortDir}
                                onClick={() => requestSort('group')}
                                ariaLabel={t('targets.sortBy', { column: t('targets.detail.overview.group') })}
                              />
                            </TH>
                            <TH className="pr-5 text-right">{t('fields.actions')}</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {filtered.map(target => (
                            <TR key={target.id} onClick={() => openDetail(target)}>
                              <TD className="pl-5">
                                <div className="flex items-center gap-2.5">
                                  <TargetKindIcon kind={target.kind} size={22} />
                                  <span className="truncate font-medium">{target.name}</span>
                                </div>
                              </TD>
                              <TD><Badge tone="mono">{target.kind.toUpperCase()}</Badge></TD>
                              <TD className="mono text-muted-foreground">
                                {formatTargetAddress(target)}
                              </TD>
                              <TD className="text-muted-foreground">{targetGroupLabel(target, t('targets.ungrouped'))}</TD>
                              <TD className="pr-5 text-right" onClick={event => event.stopPropagation()}>
                                <Button size="sm" variant="outline" onClick={() => openDetail(target)}>
                                  <Terminal size={12} />
                                  {t('actions.connect')}
                                </Button>
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    )}
      </div>
    </>
  )
}
