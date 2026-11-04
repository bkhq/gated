import type { Target } from '@/shared/types/domain'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Activity, Loader2, Plus, Search } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TargetGroupsPanel } from '@/features/target-groups/components/target-groups-panel'
import { useTargetGroups } from '@/features/target-groups/hooks/use-target-groups-queries'
import { DeleteTargetDialog, HostKeysDialog, TargetCard, TargetFormDrawer, TargetRow, TargetViewToggle } from '@/features/targets/components'
import { useTargetView } from '@/features/targets/hooks/use-target-view'
import { useCheckTargets, useTargets, useTargetStatuses } from '@/features/targets/hooks/use-targets-queries'
import { BulkActionBar } from '@/shared/components/bulk-action-bar'
import { PageHeader } from '@/shared/components/page-header'
import { Pager } from '@/shared/components/pager'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Table, TBody, TH, THead, TR } from '@/shared/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs'

const PAGE_SIZE = 50

type StatusFilter = 'all' | 'up' | 'down' | 'unknown'

function statusOf(target: Target): Exclude<StatusFilter, 'all'> {
  if (!target.status)
    return 'unknown'
  return target.status.reachable ? 'up' : 'down'
}

interface DrawerState {
  mode: 'create' | 'edit'
  target: Target | null
}

export function AdminTargetsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const search = useSearch({ from: '/admin/targets/' })
  const showGroups = search.view === 'groups'

  return (
    <>
      <PageHeader
        title={t('nav.adminTargets')}
        description={t('targets.adminDescription')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminTargets') },
        ]}
        tabs={(
          <Tabs
            value={showGroups ? 'groups' : 'targets'}
            onChange={next => void navigate({ to: '/admin/targets', search: next === 'groups' ? { view: 'groups' } : {} })}
          >
            <TabsList>
              <TabsTrigger value="targets">{t('targets.views.targets')}</TabsTrigger>
              <TabsTrigger value="groups">{t('targets.views.groups')}</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      />
      {showGroups
        ? <TargetGroupsPanel onShowTargets={group => void navigate({ to: '/admin/targets', search: { group } })} />
        : <TargetsView groupFilter={search.group ?? 'all'} onGroupFilter={group => void navigate({ to: '/admin/targets', search: group === 'all' ? {} : { group } })} />}
    </>
  )
}

function TargetsView({ groupFilter, onGroupFilter }: { groupFilter: string, onGroupFilter: (group: string) => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [view, setView] = useTargetView()
  const targetsData = useTargets().data
  const statuses = useTargetStatuses().data
  const targets = React.useMemo(
    () => (targetsData ?? []).map(target => ({ ...target, status: statuses?.get(target.id) ?? null })),
    [targetsData, statuses],
  )
  const check = useCheckTargets()
  const groupsData = useTargetGroups().data
  const groups = React.useMemo(() => groupsData ?? [], [groupsData])
  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [hostKeysTarget, setHostKeysTarget] = React.useState<Target | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<Target | null>(null)
  const [query, setQuery] = React.useState('')
  const [kindFilter, setKindFilter] = React.useState<'all' | Target['kind']>('all')
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all')
  const [offset, setOffset] = React.useState(0)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())

  // target.group holds the backend group_id; resolve display names from the
  // real target-groups list.
  const groupNameById = React.useMemo(
    () => new Map(groups.map(group => [group.id, group.name])),
    [groups],
  )
  const groupOptions = React.useMemo(() => [
    { value: 'all', label: t('targets.filters.allGroups') },
    ...groups.map(group => ({ value: group.id, label: group.name })),
  ], [groups, t])

  const filtered = React.useMemo(() => {
    return targets.filter((target) => {
      if (kindFilter !== 'all' && target.kind !== kindFilter)
        return false
      if (groupFilter !== 'all' && target.group !== groupFilter)
        return false
      if (statusFilter !== 'all' && statusOf(target) !== statusFilter)
        return false
      if (query && !`${target.name} ${target.host} ${target.user}`.toLowerCase().includes(query.toLowerCase()))
        return false
      return true
    })
  }, [targets, kindFilter, groupFilter, statusFilter, query])

  const counts = React.useMemo(() => {
    const result = { up: 0, down: 0, unknown: 0 }
    for (const target of targets)
      result[statusOf(target)] += 1
    return result
  }, [targets])

  // Filters reset the page; an offset past the end (after a delete) does too.
  const pageOffset = offset < filtered.length ? offset : 0
  const paged = filtered.slice(pageOffset, pageOffset + PAGE_SIZE)
  const filteredIds = filtered.map(target => target.id)
  const selectedIds = filteredIds.filter(id => selected.has(id))
  const pageAllSelected = paged.length > 0 && paged.every(target => selected.has(target.id))
  const pageSomeSelected = !pageAllSelected && paged.some(target => selected.has(target.id))

  const setTargetSelected = (id: string, value: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (value)
        next.add(id)
      else
        next.delete(id)
      return next
    })
  }
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const target of paged) {
        if (pageAllSelected)
          next.delete(target.id)
        else
          next.add(target.id)
      }
      return next
    })
  }
  const runCheck = (ids: string[]) => {
    if (ids.length > 0)
      check.mutate(ids)
  }
  const filtering = kindFilter !== 'all' || groupFilter !== 'all' || statusFilter !== 'all' || query !== ''

  const openDetail = (target: Target) => {
    void navigate({ to: '/admin/targets/$targetId', params: { targetId: target.id } })
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[320px]">
          <Input
            icon={Search}
            placeholder={`${t('actions.search')}…`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOffset(0)
            }}
            aria-label={t('actions.search')}
          />
        </div>
        <Select
          className="w-[160px]"
          value={kindFilter}
          onValueChange={(value) => {
            setKindFilter(value as 'all' | Target['kind'])
            setOffset(0)
          }}
          aria-label={t('fields.protocol')}
          options={[
            { value: 'all', label: t('targets.filters.allProtocols') },
            { value: 'ssh', label: 'SSH' },
            { value: 'mysql', label: 'MySQL' },
            { value: 'postgres', label: 'PostgreSQL' },
            { value: 'http', label: 'HTTP' },
          ]}
        />
        <Select
          className="w-[160px]"
          value={groupFilter}
          onValueChange={(value) => {
            onGroupFilter(value)
            setOffset(0)
          }}
          aria-label={t('targets.detail.overview.group')}
          options={groupOptions}
        />
        <Select
          className="w-[140px]"
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value as StatusFilter)
            setOffset(0)
          }}
          aria-label={t('targets.status.filter')}
          options={[
            { value: 'all', label: t('targets.status.all') },
            { value: 'up', label: t('targets.status.up') },
            { value: 'down', label: t('targets.status.down') },
            { value: 'unknown', label: t('targets.status.unknown') },
          ]}
        />
        {filtering
          ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setKindFilter('all')
                  setStatusFilter('all')
                  onGroupFilter('all')
                  setQuery('')
                  setOffset(0)
                }}
              >
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span className="text-[12px] text-muted-foreground" aria-live="polite">
          {t('targets.status.summary', { total: targets.length, up: counts.up, down: counts.down, unknown: counts.unknown })}
        </span>
        <Button size="sm" variant="outline" disabled={check.isPending || filtered.length === 0} onClick={() => runCheck(filteredIds)}>
          {check.isPending ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
          <span>{filtering ? t('targets.actions.checkFiltered', { count: filtered.length }) : t('targets.actions.checkAll')}</span>
        </Button>
        <TargetViewToggle view={view} onChange={setView} />
        <Button size="sm" onClick={() => setDrawer({ mode: 'create', target: null })}>
          <Plus size={13} />
          <span>{t('targets.actions.newTarget')}</span>
        </Button>
      </div>

      <BulkActionBar selectedCount={selectedIds.length} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => runCheck(selectedIds)}>
          <Activity size={13} />
          <span>{t('targets.actions.checkReachability')}</span>
        </Button>
        {selectedIds.length < filtered.length
          ? (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(filteredIds))}>
                {t('targets.actions.selectAllFiltered', { count: filtered.length })}
              </Button>
            )
          : null}
      </BulkActionBar>

      <div className="px-6 pb-6">
        {view === 'grid'
          ? (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
                {paged.map(target => (
                  <TargetCard
                    key={target.id}
                    target={{ ...target, groupName: groupNameById.get(target.group) ?? '' }}
                    mode="admin"
                    onOpen={openDetail}
                    onEdit={item => setDrawer({ mode: 'edit', target: item })}
                    onDelete={setDeleteTarget}
                    onHostKeys={setHostKeysTarget}
                    onCheck={item => runCheck([item.id])}
                    selected={selected.has(target.id)}
                    onSelectedChange={value => setTargetSelected(target.id, value)}
                  />
                ))}
              </div>
            )
          : (
              <Table>
                <THead>
                  <TR>
                    <TH className="w-[44px] pl-5">
                      <Checkbox
                        checked={pageAllSelected}
                        indeterminate={pageSomeSelected}
                        onCheckedChange={togglePage}
                        aria-label={t('targets.selectPage')}
                      />
                    </TH>
                    <TH>{t('fields.name')}</TH>
                    <TH>{t('fields.protocol')}</TH>
                    <TH>{t('fields.address')}</TH>
                    <TH>{t('targets.detail.overview.group')}</TH>
                    <TH>{t('targets.status.label')}</TH>
                    <TH className="pr-5 text-right" aria-label={t('fields.actions')} />
                  </TR>
                </THead>
                <TBody>
                  {paged.map(target => (
                    <TargetRow
                      key={target.id}
                      target={target}
                      mode="admin"
                      groupName={groupNameById.get(target.group) ?? ''}
                      onOpen={openDetail}
                      onEdit={t => setDrawer({ mode: 'edit', target: t })}
                      onDelete={setDeleteTarget}
                      onHostKeys={setHostKeysTarget}
                      onCheck={item => runCheck([item.id])}
                      selected={selected.has(target.id)}
                      onSelectedChange={value => setTargetSelected(target.id, value)}
                    />
                  ))}
                </TBody>
              </Table>
            )}
        <Pager offset={pageOffset} pageSize={PAGE_SIZE} total={filtered.length} onOffsetChange={setOffset} />
      </div>

      <TargetFormDrawer
        open={drawer !== null}
        mode={drawer?.mode ?? 'create'}
        target={drawer?.target ?? null}
        onClose={() => setDrawer(null)}
      />
      <DeleteTargetDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
      <HostKeysDialog
        open={hostKeysTarget !== null}
        target={hostKeysTarget}
        onClose={() => setHostKeysTarget(null)}
      />
    </>
  )
}
