import type { Target } from '@/shared/types/domain'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Plus, Search } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TargetGroupsPanel } from '@/features/target-groups/components/target-groups-panel'
import { useTargetGroups } from '@/features/target-groups/hooks/use-target-groups-queries'
import { DeleteTargetDialog, HostKeysDialog, TargetCard, TargetFormDrawer, TargetRow, TargetViewToggle } from '@/features/targets/components'
import { useTargetView } from '@/features/targets/hooks/use-target-view'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { PageHeader } from '@/shared/components/page-header'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Table, TBody, TH, THead, TR } from '@/shared/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs'

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
  const targets = React.useMemo(() => targetsData ?? [], [targetsData])
  const groupsData = useTargetGroups().data
  const groups = React.useMemo(() => groupsData ?? [], [groupsData])
  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [hostKeysTarget, setHostKeysTarget] = React.useState<Target | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<Target | null>(null)
  const [query, setQuery] = React.useState('')
  const [kindFilter, setKindFilter] = React.useState<'all' | Target['kind']>('all')

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
      if (query && !`${target.name} ${target.host} ${target.user}`.toLowerCase().includes(query.toLowerCase()))
        return false
      return true
    })
  }, [targets, kindFilter, groupFilter, query])

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
            onChange={event => setQuery(event.target.value)}
            aria-label={t('actions.search')}
          />
        </div>
        <Select
          className="w-[160px]"
          value={kindFilter}
          onValueChange={value => setKindFilter(value as 'all' | Target['kind'])}
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
          onValueChange={onGroupFilter}
          aria-label={t('targets.detail.overview.group')}
          options={groupOptions}
        />
        {(kindFilter !== 'all' || groupFilter !== 'all' || query)
          ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setKindFilter('all')
                  onGroupFilter('all')
                  setQuery('')
                }}
              >
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <TargetViewToggle view={view} onChange={setView} />
        <Button size="sm" onClick={() => setDrawer({ mode: 'create', target: null })}>
          <Plus size={13} />
          <span>{t('targets.actions.newTarget')}</span>
        </Button>
      </div>

      <div className="px-6 pb-6">
        {view === 'grid'
          ? (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
                {filtered.map(target => (
                  <TargetCard
                    key={target.id}
                    target={{ ...target, groupName: groupNameById.get(target.group) ?? '' }}
                    mode="admin"
                    onOpen={openDetail}
                    onEdit={item => setDrawer({ mode: 'edit', target: item })}
                    onDelete={setDeleteTarget}
                    onHostKeys={setHostKeysTarget}
                  />
                ))}
              </div>
            )
          : (
              <Table>
                <THead>
                  <TR>
                    <TH className="pl-5">{t('fields.name')}</TH>
                    <TH>{t('fields.protocol')}</TH>
                    <TH>{t('fields.address')}</TH>
                    <TH>{t('targets.detail.overview.group')}</TH>
                    <TH className="pr-5 text-right" aria-label={t('fields.actions')} />
                  </TR>
                </THead>
                <TBody>
                  {filtered.map(target => (
                    <TargetRow
                      key={target.id}
                      target={target}
                      mode="admin"
                      groupName={groupNameById.get(target.group) ?? ''}
                      onOpen={openDetail}
                      onEdit={t => setDrawer({ mode: 'edit', target: t })}
                      onDelete={setDeleteTarget}
                      onHostKeys={setHostKeysTarget}
                    />
                  ))}
                </TBody>
              </Table>
            )}
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
