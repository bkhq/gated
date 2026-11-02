import type { SortDir } from '@/shared/components/sort'
import type { Role } from '@/shared/types/domain'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  Copy,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RoleFormDialog } from '@/features/roles/components'
import { useDeleteRole, useRoleReferences, useRoles } from '@/features/roles/hooks/use-roles-queries'
import { BulkActionBar } from '@/shared/components/bulk-action-bar'
import { DeleteWithReferencesDialog } from '@/shared/components/delete-with-references-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { RowActionsMenu } from '@/shared/components/row-actions-menu'
import { ariaSort } from '@/shared/components/sort'
import { SortHeader } from '@/shared/components/sort-header'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const KIND_KEYS = ['all', 'builtin', 'custom'] as const
type KindFilter = (typeof KIND_KEYS)[number]

interface DrawerState {
  mode: 'create' | 'edit'
  role: Role | null
}

export function AdminRolesPage() {
  const { t } = useTranslation()
  const rolesQuery = useRoles()
  const roles = React.useMemo(() => rolesQuery.data ?? [], [rolesQuery.data])

  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Role | null>(null)
  const [pendingBatchDelete, setPendingBatchDelete] = React.useState<Role[] | null>(null)
  const [kindFilter, setKindFilter] = React.useState<KindFilter>('all')
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = roles.filter((role) => {
      if (kindFilter === 'builtin' && !role.builtin) {
        return false
      }
      if (kindFilter === 'custom' && role.builtin) {
        return false
      }
      if (needle) {
        const haystack = `${role.name} ${role.description}`.toLowerCase()
        if (!haystack.includes(needle)) {
          return false
        }
      }
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => a.name.localeCompare(b.name) * dir)
    return list
  }, [roles, kindFilter, query, sortDir])

  const filteredIds = React.useMemo(() => filtered.map(role => role.id), [filtered])
  const visibleSelected = React.useMemo(
    () => filteredIds.filter(id => selected.has(id)),
    [filteredIds, selected],
  )
  const allVisibleSelected = filteredIds.length > 0 && visibleSelected.length === filteredIds.length
  const someVisibleSelected = visibleSelected.length > 0 && !allVisibleSelected

  const hasActiveFilters = Boolean(query) || kindFilter !== 'all'

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      }
      else {
        next.add(id)
      }
      return next
    })
  }

  function toggleAllVisible() {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of filteredIds) {
          next.delete(id)
        }
        return next
      })
    }
    else {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of filteredIds) {
          next.add(id)
        }
        return next
      })
    }
  }

  function clearSelection() {
    setSelected(new Set())
  }

  function clearFilters() {
    setQuery('')
    setKindFilter('all')
  }

  function toggleSort() {
    setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
  }

  function openEdit(role: Role) {
    setDrawer({ mode: 'edit', role })
  }

  function startDuplicate(role: Role) {
    setDrawer({
      mode: 'create',
      role: {
        ...role,
        id: '',
        builtin: false,
        name: `${role.name} (copy)`,
      },
    })
  }

  const selectedRoles = React.useMemo(() => {
    const set = new Set(visibleSelected)
    return filtered.filter(role => set.has(role.id))
  }, [filtered, visibleSelected])

  const isLoading = rolesQuery.isLoading
  const isEmpty = !isLoading && roles.length === 0
  const isFilteredEmpty = !isLoading && roles.length > 0 && filtered.length === 0

  return (
    <>
      <PageHeader
        title={t('nav.adminRoles')}
        description={t('roles.description')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminRoles') },
        ]}
        actions={(
          <Button size="sm" onClick={() => setDrawer({ mode: 'create', role: null })}>
            <Plus size={13} />
            <span>{t('roles.actions.newRole')}</span>
          </Button>
        )}
      />

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[320px]">
          <Input
            icon={Search}
            placeholder={t('roles.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('actions.search')}
          />
        </div>
        <Select
          className="w-[160px]"
          aria-label={t('roles.fields.kind')}
          value={kindFilter}
          onValueChange={value => setKindFilter(value as KindFilter)}
          options={KIND_KEYS.map(key => ({
            value: key,
            label: key === 'all' ? t('roles.filter.allKind') : t(`roles.filter.${key}`),
          }))}
        />
        {hasActiveFilters
          ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span className="text-[12px] text-muted-foreground">
          {filtered.length}
          {' / '}
          {roles.length}
        </span>
      </div>

      <BulkActionBar
        selectedCount={visibleSelected.length}
        onClear={clearSelection}
      >
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            const deletable = selectedRoles.filter(role => !role.builtin)
            if (deletable.length === 0) {
              return
            }
            setPendingBatchDelete(deletable)
          }}
          disabled={!selectedRoles.some(role => !role.builtin)}
          title={selectedRoles.some(role => !role.builtin) ? undefined : t('roles.delete.builtinBlocked')}
        >
          <Trash2 size={13} />
          <span>{t('roles.actions.batchDelete')}</span>
        </Button>
      </BulkActionBar>

      <div className="px-6 pb-6">
        {isLoading
          ? <RolesTableSkeleton />
          : isEmpty
            ? (
                <EmptyState
                  icon={ShieldCheck}
                  title={t('roles.empty.title')}
                  description={t('roles.empty.description')}
                  action={(
                    <Button size="sm" onClick={() => setDrawer({ mode: 'create', role: null })}>
                      <Plus size={13} />
                      <span>{t('roles.actions.newRole')}</span>
                    </Button>
                  )}
                />
              )
            : isFilteredEmpty
              ? (
                  <EmptyState
                    icon={Search}
                    title={t('roles.empty.filteredTitle')}
                    description={t('roles.empty.filteredDescription')}
                    action={(
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        {t('actions.clearFilters')}
                      </Button>
                    )}
                  />
                )
              : (
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-[44px] pl-5">
                          <Checkbox
                            checked={allVisibleSelected}
                            indeterminate={someVisibleSelected}
                            onCheckedChange={toggleAllVisible}
                            aria-label={t('roles.list.selectAll')}
                            aria-checked={someVisibleSelected ? 'mixed' : allVisibleSelected}
                          />
                        </TH>
                        <TH className="pl-1" aria-sort={ariaSort(true, sortDir)}>
                          <SortHeader
                            label={t('fields.name')}
                            active
                            dir={sortDir}
                            onClick={toggleSort}
                          />
                        </TH>
                        <TH>{t('roles.fields.kind')}</TH>
                        <TH className="w-[60px] pr-5 text-right" aria-label={t('fields.actions')} />
                      </TR>
                    </THead>
                    <TBody>
                      {filtered.map(role => (
                        <RoleRow
                          key={role.id}
                          role={role}
                          checked={selected.has(role.id)}
                          onToggle={() => toggleRow(role.id)}
                          onOpen={() => openEdit(role)}
                          onEdit={() => setDrawer({ mode: 'edit', role })}
                          onDuplicate={() => startDuplicate(role)}
                          onDelete={() => setPendingDelete(role)}
                        />
                      ))}
                    </TBody>
                  </Table>
                )}
      </div>

      <RoleFormDialog
        open={drawer !== null}
        mode={drawer?.mode ?? 'create'}
        role={drawer?.role ?? null}
        onClose={() => setDrawer(null)}
      />

      <DeleteRoleDialog
        role={pendingDelete}
        onClose={() => setPendingDelete(null)}
        triggerEdit={(role) => {
          setPendingDelete(null)
          setDrawer({ mode: 'edit', role })
        }}
      />

      <BatchDeleteRolesDialog
        roles={pendingBatchDelete}
        onClose={() => setPendingBatchDelete(null)}
        onDeleted={() => {
          setPendingBatchDelete(null)
          clearSelection()
        }}
      />
    </>
  )
}

function RoleRow({ role, checked, onToggle, onOpen, onEdit, onDuplicate, onDelete }: {
  role: Role
  checked: boolean
  onToggle: () => void
  onOpen: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation()
  return (
    <TR onClick={onOpen}>
      <TD className="pl-5" onClick={stop}>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          aria-label={t('roles.list.selectRow', { name: role.name })}
        />
      </TD>
      <TD className="pl-1">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
            {role.builtin ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium">{role.name}</div>
            <div className="line-clamp-1 text-[12px] text-muted-foreground">{role.description || '—'}</div>
          </div>
        </div>
      </TD>
      <TD>
        <div className="flex flex-wrap items-center gap-1.5">
          {role.builtin
            ? <Badge tone="info">{t('roles.kind.builtin')}</Badge>
            : <Badge tone="mono">{t('roles.kind.custom')}</Badge>}
          {role.allowFileTransfer === false
            ? <Badge tone="warning">{t('roles.list.noFileTransfer')}</Badge>
            : null}
        </div>
      </TD>
      <TD className="pr-5 text-right" onClick={stop}>
        <RowActionsMenu
          items={[
            { label: t('actions.edit'), icon: ShieldCheck, onClick: onEdit },
            { label: t('roles.actions.duplicate'), icon: Copy, onClick: onDuplicate },
            ...(role.builtin
              ? []
              : [
                  'separator' as const,
                  {
                    label: t('actions.delete'),
                    icon: Trash2,
                    danger: true,
                    onClick: onDelete,
                  },
                ]),
          ]}
        />
      </TD>
    </TR>
  )
}

function RolesTableSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={`role-skeleton-${String(index)}`}
          className="flex items-center gap-3 px-5 py-3"
          style={{ borderTop: index === 0 ? 'none' : '1px solid hsl(var(--border))' }}
        >
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="flex-1">
            <Skeleton className="mb-1.5 h-3.5 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-5 w-14" />
          <Skeleton className="h-5 w-10" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </Card>
  )
}

function DeleteRoleDialog({ role, onClose, triggerEdit }: {
  role: Role | null
  onClose: () => void
  triggerEdit: (role: Role) => void
}) {
  const { t } = useTranslation()
  const references = useRoleReferences(role?.id)
  const deleteMutation = useDeleteRole()

  if (!role) {
    return null
  }

  const isBuiltin = Boolean(role.builtin)
  const refData = references.data
  const userCount = refData?.userCount ?? 0
  const accountCount = refData?.accountCount ?? 0
  const hasRefs = userCount + accountCount > 0

  // Builtin roles need a neutral (muted) notice instead of the warning-tone box,
  // and the delete button is blocked rather than swapped for "Open instead".
  // For that visual nuance we render a custom Dialog; the generic
  // DeleteWithReferencesDialog handles the non-builtin paths.
  if (isBuiltin) {
    return (
      <Dialog open onClose={onClose} width={460}>
        <div className="flex flex-col">
          <div className="px-6 pb-3 pt-5">
            <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">{t('roles.delete.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
              {t('roles.delete.body', { name: role.name })}
            </DialogPrimitive.Description>
            <div className="mt-3 rounded-md border border-border bg-muted/60 p-3 text-[13px] text-foreground">
              <div className="font-semibold">{t('roles.delete.builtinBlocked')}</div>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
            <Button variant="destructive" disabled>
              {t('actions.delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const confirm = async () => {
    if (hasRefs) {
      return
    }
    await deleteMutation.mutateAsync(role.id)
    onClose()
  }

  return (
    <DeleteWithReferencesDialog
      open
      width={460}
      title={t('roles.delete.title')}
      body={t('roles.delete.body', { name: role.name })}
      warning={hasRefs
        ? {
            title: t('roles.delete.warnTitle'),
            body: t('roles.delete.warnBody', { users: userCount, accounts: accountCount }),
          }
        : null}
      hasReferences={hasRefs}
      showOpenInstead
      openInsteadLabel={t('roles.delete.openInstead')}
      onClose={onClose}
      onConfirm={() => { void confirm() }}
      onOpenInstead={() => triggerEdit(role)}
      isPending={deleteMutation.isPending}
    />
  )
}

function BatchDeleteRolesDialog({ roles, onClose, onDeleted }: {
  roles: Role[] | null
  onClose: () => void
  onDeleted: () => void
}) {
  const { t } = useTranslation()
  const deleteMutation = useDeleteRole()

  if (!roles || roles.length === 0) {
    return null
  }

  const count = roles.length

  const confirm = async () => {
    await Promise.all(
      roles
        .filter(role => !role.builtin)
        .map(async role => deleteMutation.mutateAsync(role.id)),
    )
    onDeleted()
  }

  return (
    <Dialog open onClose={onClose} width={460}>
      <div className="flex flex-col">
        <div className="px-6 pb-3 pt-5">
          <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">{t('roles.delete.batchTitle', { count })}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
            {t('roles.delete.batchBody', { count })}
          </DialogPrimitive.Description>
          <Card className="mt-3 max-h-[160px] overflow-y-auto p-3 text-[13px]">
            <ul className="m-0 list-none space-y-1 p-0">
              {roles.map(role => (
                <li key={role.id} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    {role.builtin ? <ShieldOff size={12} className="text-muted-foreground" /> : <ShieldCheck size={12} />}
                    <span>{role.name}</span>
                  </span>
                  {role.builtin
                    ? <Badge tone="mono">{t('roles.kind.builtin')}</Badge>
                    : null}
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button
            variant="destructive"
            onClick={() => { void confirm() }}
            disabled={deleteMutation.isPending}
          >
            {t('roles.delete.batchConfirm', { count })}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
