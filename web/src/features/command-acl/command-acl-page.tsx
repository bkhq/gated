import type { CommandAclAction, CommandAclRule } from '@/shared/lib/api/command-acl'
import { Pencil, Plus, Search, ShieldBan, Trash2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CommandAclFormDialog } from '@/features/command-acl/components/command-acl-form-dialog'
import { useCommandAclRules, useDeleteCommandAclRule } from '@/features/command-acl/hooks/use-command-acl-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { RowActionsMenu } from '@/shared/components/row-actions-menu'
import { StatCard } from '@/shared/components/stat-card'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const ACTION_TONE: Record<CommandAclAction, 'success' | 'danger' | 'warning'> = {
  allow: 'success',
  deny: 'danger',
  review: 'warning',
}

interface DrawerState {
  mode: 'create' | 'edit'
  rule: CommandAclRule | null
}

export function CommandAclPage() {
  const { t } = useTranslation()
  const rulesQuery = useCommandAclRules()
  const rules = React.useMemo(() => rulesQuery.data ?? [], [rulesQuery.data])
  const deleteMutation = useDeleteCommandAclRule()

  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<CommandAclRule | null>(null)
  const [query, setQuery] = React.useState('')
  const [actionFilter, setActionFilter] = React.useState<'all' | CommandAclAction>('all')

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rules.filter((rule) => {
      if (actionFilter !== 'all' && rule.action !== actionFilter)
        return false
      if (needle) {
        const haystack = `${rule.name} ${rule.pattern} ${rule.description ?? ''}`.toLowerCase()
        if (!haystack.includes(needle))
          return false
      }
      return true
    })
  }, [rules, query, actionFilter])

  const hasActiveFilters = Boolean(query) || actionFilter !== 'all'
  const isLoading = rulesQuery.isLoading
  const isEmpty = !isLoading && rules.length === 0
  const isFilteredEmpty = !isLoading && rules.length > 0 && filtered.length === 0

  const confirmDelete = async () => {
    if (!pendingDelete)
      return
    await deleteMutation.mutateAsync(pendingDelete.id)
    setPendingDelete(null)
  }

  return (
    <>
      <PageHeader
        title={t('nav.adminCommandAcl')}
        description={t('commandAcl.description')}
        breadcrumbs={[{ label: t('section.admin') }, { label: t('nav.adminCommandAcl') }]}
        actions={(
          <Button size="sm" onClick={() => setDrawer({ mode: 'create', rule: null })}>
            <Plus size={13} />
            <span>{t('commandAcl.actions.newRule')}</span>
          </Button>
        )}
      />

      <div className="grid gap-3 px-6 pt-4 sm:grid-cols-2">
        <StatCard label={t('commandAcl.stats.total')} value={rules.length} icon={ShieldBan} />
        <StatCard label={t('commandAcl.stats.enabled')} value={rules.filter(r => r.enabled).length} icon={ShieldBan} />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[320px]">
          <Input
            icon={Search}
            placeholder={t('commandAcl.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('actions.search')}
          />
        </div>
        <Select
          className="w-[160px]"
          aria-label={t('commandAcl.fields.action')}
          value={actionFilter}
          onValueChange={value => setActionFilter(value as 'all' | CommandAclAction)}
          options={[
            { value: 'all', label: t('commandAcl.filter.allActions') },
            { value: 'allow', label: t('commandAcl.action.allow') },
            { value: 'deny', label: t('commandAcl.action.deny') },
            { value: 'review', label: t('commandAcl.action.review') },
          ]}
        />
        {hasActiveFilters
          ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('')
                  setActionFilter('all')
                }}
              >
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span className="text-[12px] text-muted-foreground">
          {filtered.length}
          {' / '}
          {rules.length}
        </span>
      </div>

      <div className="px-6 pb-6">
        {isLoading
          ? <TableSkeleton />
          : isEmpty
            ? (
                <EmptyState
                  icon={ShieldBan}
                  title={t('commandAcl.empty.title')}
                  description={t('commandAcl.empty.description')}
                  action={(
                    <Button size="sm" onClick={() => setDrawer({ mode: 'create', rule: null })}>
                      <Plus size={13} />
                      <span>{t('commandAcl.actions.newRule')}</span>
                    </Button>
                  )}
                />
              )
            : isFilteredEmpty
              ? (
                  <EmptyState
                    icon={Search}
                    title={t('commandAcl.empty.filteredTitle')}
                    description={t('commandAcl.empty.filteredDescription')}
                  />
                )
              : (
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-[70px] pl-5">{t('commandAcl.fields.priority')}</TH>
                        <TH>{t('fields.name')}</TH>
                        <TH>{t('fields.protocol')}</TH>
                        <TH>{t('commandAcl.fields.matchType')}</TH>
                        <TH>{t('commandAcl.fields.pattern')}</TH>
                        <TH>{t('commandAcl.fields.action')}</TH>
                        <TH>{t('commandAcl.fields.enabled')}</TH>
                        <TH className="w-[60px] pr-5 text-right" aria-label={t('fields.actions')} />
                      </TR>
                    </THead>
                    <TBody>
                      {filtered.map(rule => (
                        <RuleRow
                          key={rule.id}
                          rule={rule}
                          onEdit={() => setDrawer({ mode: 'edit', rule })}
                          onDelete={() => setPendingDelete(rule)}
                        />
                      ))}
                    </TBody>
                  </Table>
                )}
      </div>

      <CommandAclFormDialog
        open={drawer !== null}
        mode={drawer?.mode ?? 'create'}
        rule={drawer?.rule ?? null}
        onClose={() => setDrawer(null)}
      />

      <Dialog open={pendingDelete !== null} onClose={() => setPendingDelete(null)} width={440}>
        <div className="flex flex-col">
          <div className="px-6 pb-3 pt-5">
            <h2 className="m-0 text-[16px] font-semibold">{t('commandAcl.delete.title')}</h2>
            <p className="mt-2 text-[13.5px] text-muted-foreground">
              {t('commandAcl.delete.body', { name: pendingDelete?.name ?? '' })}
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setPendingDelete(null)}>{t('actions.cancel')}</Button>
            <Button variant="destructive" onClick={() => { void confirmDelete() }} disabled={deleteMutation.isPending}>
              {t('actions.delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}

function RuleRow({ rule, onEdit, onDelete }: {
  rule: CommandAclRule
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation()
  return (
    <TR onClick={onEdit}>
      <TD className="mono tabular pl-5 text-[12.5px] text-muted-foreground">{rule.priority}</TD>
      <TD>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium">{rule.name}</div>
          {rule.description ? <div className="line-clamp-1 text-[12px] text-muted-foreground">{rule.description}</div> : null}
        </div>
      </TD>
      <TD><Badge tone="mono">{rule.protocol}</Badge></TD>
      <TD className="text-[12.5px] text-muted-foreground">{t(`commandAcl.matchType.${rule.match_type}`)}</TD>
      <TD className="mono max-w-[240px] truncate text-[12.5px]" title={rule.pattern}>{rule.pattern}</TD>
      <TD><Badge tone={ACTION_TONE[rule.action]}>{t(`commandAcl.action.${rule.action}`)}</Badge></TD>
      <TD>
        {rule.enabled
          ? <Badge tone="success">{t('commandAcl.status.enabled')}</Badge>
          : <Badge tone="mono">{t('commandAcl.status.disabled')}</Badge>}
      </TD>
      <TD className="pr-5 text-right" onClick={stop}>
        <RowActionsMenu
          items={[
            { label: t('actions.edit'), icon: Pencil, onClick: onEdit },
            'separator',
            { label: t('actions.delete'), icon: Trash2, danger: true, onClick: onDelete },
          ]}
        />
      </TD>
    </TR>
  )
}

function TableSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={`acl-skeleton-${String(index)}`}
          className="flex items-center gap-3 px-5 py-3"
          style={{ borderTop: index === 0 ? 'none' : '1px solid hsl(var(--border))' }}
        >
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-5 w-14" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-5 w-14" />
        </div>
      ))}
    </Card>
  )
}
