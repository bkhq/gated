import type { SortDir } from '@/shared/components/sort'
import type { User } from '@/shared/types/domain'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users as UsersIcon,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useRoles } from '@/features/roles/hooks/use-roles-queries'
import { useLiveSessions } from '@/features/sessions/hooks/use-sessions-queries'
import { UserFormDialog } from '@/features/users/components'
import { useBulkDeleteUsers, useDeleteUser, useSetUserPassword, useUserReferences, useUsers } from '@/features/users/hooks/use-users-queries'
import { BulkActionBar } from '@/shared/components/bulk-action-bar'
import { DeleteWithReferencesDialog } from '@/shared/components/delete-with-references-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { RowActionsMenu } from '@/shared/components/row-actions-menu'
import { ariaSort } from '@/shared/components/sort'
import { SortHeader } from '@/shared/components/sort-header'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const PAGE_SIZE = 10

type RoleFilter = 'all' | string
type SortKey = 'name'

interface DrawerState {
  mode: 'create' | 'edit'
  user: User | null
}

function compareUsers(a: User, b: User, key: SortKey, dir: SortDir): number {
  let cmp = 0
  switch (key) {
    case 'name':
      cmp = a.name.localeCompare(b.name)
      break
  }
  return dir === 'asc' ? cmp : -cmp
}

export function AdminUsersPage() {
  const { t } = useTranslation()
  const usersQuery = useUsers()
  const rolesQuery = useRoles()
  const liveSessionsQuery = useLiveSessions()
  const users = usersQuery.data
  const roles = React.useMemo(() => rolesQuery.data ?? [], [rolesQuery.data])
  const liveSessions = React.useMemo(() => liveSessionsQuery.data ?? [], [liveSessionsQuery.data])

  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<User | null>(null)
  const [pendingBulkDelete, setPendingBulkDelete] = React.useState<User[] | null>(null)
  const [resetPasswordUser, setResetPasswordUser] = React.useState<User | null>(null)
  const [roleFilter, setRoleFilter] = React.useState<RoleFilter>('all')
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [sortKey, setSortKey] = React.useState<SortKey>('name')
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')
  const [page, setPage] = React.useState(1)

  const bulkDeleteMutation = useBulkDeleteUsers()

  const hasActiveFilters = roleFilter !== 'all' || query.trim().length > 0

  const filtered = React.useMemo(() => {
    if (!users) {
      return []
    }
    const needle = query.trim().toLowerCase()
    const result = users.filter((user) => {
      if (roleFilter !== 'all' && !user.roles.includes(roleFilter)) {
        return false
      }
      if (needle) {
        const haystack = `${user.name} ${user.username}`.toLowerCase()
        if (!haystack.includes(needle)) {
          return false
        }
      }
      return true
    })
    result.sort((a, b) => compareUsers(a, b, sortKey, sortDir))
    return result
  }, [users, roleFilter, query, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const paged = filtered.slice(pageStart, pageStart + PAGE_SIZE)

  const selectedUsers = React.useMemo(
    () => (users ?? []).filter(user => selected.has(user.id)),
    [users, selected],
  )

  const roleOptions = React.useMemo(() => [
    { value: 'all', label: t('users.filter.allRoles') },
    ...roles.map(role => ({ value: role.name, label: role.name })),
  ], [roles, t])

  const clearFilters = () => {
    setQuery('')
    setRoleFilter('all')
  }

  const pageAllSelected = paged.length > 0 && paged.every(user => selected.has(user.id))
  const pageSomeSelected = paged.some(user => selected.has(user.id)) && !pageAllSelected

  const togglePageSelection = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (pageAllSelected) {
        for (const user of paged) {
          next.delete(user.id)
        }
      }
      else {
        for (const user of paged) {
          next.add(user.id)
        }
      }
      return next
    })
  }

  const toggleOne = (id: string) => {
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

  const requestSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    }
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const onBulkDeleteRequest = () => {
    if (selectedUsers.length === 0) {
      return
    }
    setPendingBulkDelete(selectedUsers)
  }

  const onBulkDeleteConfirm = async () => {
    if (!pendingBulkDelete) {
      return
    }
    await bulkDeleteMutation.mutateAsync(pendingBulkDelete.map(user => user.id))
    setPendingBulkDelete(null)
    setSelected(new Set())
  }

  const openEdit = (user: User) => setDrawer({ mode: 'edit', user })
  const openCreate = () => setDrawer({ mode: 'create', user: null })

  const isLoading = usersQuery.isLoading
  const isError = usersQuery.isError

  return (
    <>
      <PageHeader
        title={t('nav.adminUsers')}
        description={t('users.description')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminUsers') },
        ]}
        actions={(
          <Button size="sm" onClick={openCreate}>
            <Plus size={13} />
            <span>{t('users.actions.newUser')}</span>
          </Button>
        )}
      />

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[320px]">
          <Input
            icon={Search}
            placeholder={t('users.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('actions.search')}
          />
        </div>
        <Select
          className="w-[180px]"
          value={roleFilter}
          onValueChange={value => setRoleFilter(value)}
          aria-label={t('fields.roles')}
          options={roleOptions}
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
          {t('users.pagination.range', {
            from: filtered.length === 0 ? 0 : pageStart + 1,
            to: pageStart + paged.length,
            total: filtered.length,
          })}
        </span>
      </div>

      <BulkActionBar
        selectedCount={selectedUsers.length}
        onClear={() => setSelected(new Set())}
      >
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onBulkDeleteRequest}
          disabled={bulkDeleteMutation.isPending}
        >
          <Trash2 size={13} />
          <span>{t('users.selection.delete')}</span>
        </Button>
      </BulkActionBar>

      <div className="px-6 pb-6">
        {isLoading
          ? <UsersTableSkeleton />
          : isError
            ? (
                <EmptyState
                  icon={AlertTriangle}
                  title={t('users.loadError.title')}
                  description={t('users.loadError.description')}
                  action={(
                    <Button variant="outline" size="sm" onClick={() => { void usersQuery.refetch() }}>
                      {t('users.loadError.retry')}
                    </Button>
                  )}
                />
              )
            : (users ?? []).length === 0
                ? (
                    <EmptyState
                      icon={UsersIcon}
                      title={t('users.empty.title')}
                      description={t('users.empty.description')}
                      action={(
                        <Button size="sm" onClick={openCreate}>
                          <Plus size={13} />
                          <span>{t('users.actions.newUser')}</span>
                        </Button>
                      )}
                    />
                  )
                : filtered.length === 0
                  ? (
                      <EmptyState
                        icon={Search}
                        title={t('users.empty.filteredTitle')}
                        description={t('users.empty.filteredDescription')}
                        action={(
                          <Button variant="outline" size="sm" onClick={clearFilters}>
                            {t('actions.clearFilters')}
                          </Button>
                        )}
                      />
                    )
                  : (
                      <>
                        <Table>
                          <THead>
                            <TR>
                              <TH className="w-[44px] pl-5">
                                <Checkbox
                                  checked={pageAllSelected}
                                  indeterminate={pageSomeSelected}
                                  onCheckedChange={togglePageSelection}
                                  aria-label={t('a11y.admin.config.users.selectAll')}
                                  aria-checked={pageSomeSelected ? 'mixed' : pageAllSelected}
                                />
                              </TH>
                              <TH aria-sort={ariaSort(sortKey === 'name', sortDir)}>
                                <SortHeader
                                  label={t('fields.user')}
                                  active={sortKey === 'name'}
                                  dir={sortDir}
                                  onClick={() => requestSort('name')}
                                />
                              </TH>
                              <TH>{t('users.fields.username')}</TH>
                              <TH>{t('fields.roles')}</TH>
                              <TH className="pr-5 text-right">{t('fields.actions')}</TH>
                            </TR>
                          </THead>
                          <TBody>
                            {paged.map(user => (
                              <UserRow
                                key={user.id}
                                user={user}
                                checked={selected.has(user.id)}
                                onToggle={() => toggleOne(user.id)}
                                onOpen={() => openEdit(user)}
                                onDelete={() => setPendingDelete(user)}
                                onResetPassword={() => setResetPasswordUser(user)}
                              />
                            ))}
                          </TBody>
                        </Table>

                        {totalPages > 1
                          ? (
                              <Pagination
                                page={safePage}
                                totalPages={totalPages}
                                onChange={setPage}
                              />
                            )
                          : null}
                      </>
                    )}
      </div>

      <UserFormDialog
        open={drawer !== null}
        mode={drawer?.mode ?? 'create'}
        user={drawer?.user ?? null}
        onClose={() => setDrawer(null)}
        onRequestDelete={(user) => {
          setDrawer(null)
          setPendingDelete(user)
        }}
      />

      <DeleteUserDialog
        user={pendingDelete}
        liveSessions={liveSessions}
        onClose={() => setPendingDelete(null)}
        onOpenInstead={(user) => {
          setPendingDelete(null)
          setDrawer({ mode: 'edit', user })
        }}
      />

      <BulkDeleteUsersDialog
        users={pendingBulkDelete}
        liveSessions={liveSessions}
        disabled={bulkDeleteMutation.isPending}
        onClose={() => setPendingBulkDelete(null)}
        onConfirm={() => { void onBulkDeleteConfirm() }}
      />

      <ResetPasswordDialog
        user={resetPasswordUser}
        onClose={() => setResetPasswordUser(null)}
      />
    </>
  )
}

function ResetPasswordDialog({ user, onClose }: { user: User | null, onClose: () => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = React.useState('')
  const mutation = useSetUserPassword()

  // Clear the field whenever the dialog switches user / closes.
  const [lastUserId, setLastUserId] = React.useState<string | null>(null)
  if ((user?.id ?? null) !== lastUserId) {
    setLastUserId(user?.id ?? null)
    setPassword('')
  }

  const submit = async () => {
    if (!user || !password || mutation.isPending)
      return
    await mutation.mutateAsync({ userId: user.id, password })
    onClose()
  }

  return (
    <Dialog open={user !== null} onClose={onClose}>
      <DialogHeader title={t('users.resetPassword.title', { name: user?.username ?? '' })} onClose={onClose} />
      <DialogBody className="flex flex-col gap-3">
        <div>
          <Label htmlFor="reset-password-input">{t('users.fields.password')}</Label>
          <Input
            id="reset-password-input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            placeholder={t('users.form.passwordPlaceholder')}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>{t('actions.cancel')}</Button>
        <Button size="sm" disabled={!password || mutation.isPending} onClick={() => { void submit() }}>
          {t('users.actions.resetPassword')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function UserRow({ user, checked, onToggle, onOpen, onDelete, onResetPassword }: {
  user: User
  checked: boolean
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
  onResetPassword: () => void
}) {
  const { t } = useTranslation()
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation()
  const items = [
    { label: t('actions.edit'), icon: Pencil, onClick: onOpen },
    { label: t('users.actions.resetPassword'), icon: KeyRound, onClick: onResetPassword },
    'separator' as const,
    { label: t('actions.delete'), icon: Trash2, danger: true, onClick: onDelete },
  ]
  return (
    <TR onClick={onOpen}>
      <TD className="pl-5" onClick={stop}>
        <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={t('a11y.admin.config.users.selectRow', { name: user.username })} />
      </TD>
      <TD>
        <div className="flex items-center gap-2.5">
          <Avatar name={user.name} size={32} />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium">{user.name}</div>
          </div>
        </div>
      </TD>
      <TD className="mono text-[12.5px]">{user.username}</TD>
      <TD>
        <div className="flex flex-wrap gap-1">
          {user.roles.length === 0
            ? <span className="text-[12px] text-muted-foreground">—</span>
            : user.roles.map(role => <Badge key={role} tone="outline">{role}</Badge>)}
        </div>
      </TD>
      <TD className="pr-5 text-right" onClick={stop}>
        <RowActionsMenu items={items} />
      </TD>
    </TR>
  )
}

function UsersTableSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex h-10 items-center gap-3 border-b border-border bg-[hsl(var(--muted)/0.5)] px-5">
        <Skeleton className="h-3 w-4 rounded" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={`u-skel-${String(index)}`}
          className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0"
        >
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </Card>
  )
}

function Pagination({ page, totalPages, onChange }: {
  page: number
  totalPages: number
  onChange: (page: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span className="text-[12.5px] text-muted-foreground">
        {t('users.pagination.page', { page, total: totalPages })}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label={t('users.pagination.prev')}
        >
          <ChevronLeft size={13} />
          <span>{t('users.pagination.prev')}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          aria-label={t('users.pagination.next')}
        >
          <span>{t('users.pagination.next')}</span>
          <ChevronRight size={13} />
        </Button>
      </div>
    </div>
  )
}

function DeleteUserDialog({ user, liveSessions, onClose, onOpenInstead }: {
  user: User | null
  liveSessions: { user: string }[]
  onClose: () => void
  onOpenInstead: (user: User) => void
}) {
  const { t } = useTranslation()
  const references = useUserReferences(user?.id)
  const deleteMutation = useDeleteUser()

  if (!user) {
    return null
  }

  const refData = references.data
  const roleCount = refData?.roleCount ?? user.roles.length
  const sessionCount = refData?.liveSessionCount
    ?? liveSessions.filter(session => session.user === user.username).length
  const hasRefs = roleCount + sessionCount > 0

  const confirm = async () => {
    await deleteMutation.mutateAsync(user.id)
    onClose()
  }

  return (
    <DeleteWithReferencesDialog
      open
      title={t('users.delete.title')}
      body={t('users.delete.body', { name: user.name })}
      warning={hasRefs
        ? {
            title: t('users.delete.warnTitle'),
            body: t('users.delete.warnBody', { roles: roleCount, sessions: sessionCount }),
          }
        : null}
      hasReferences={hasRefs}
      showOpenInstead
      openInsteadLabel={t('users.delete.openInstead')}
      onClose={onClose}
      onConfirm={() => { void confirm() }}
      onOpenInstead={() => onOpenInstead(user)}
      isPending={deleteMutation.isPending}
    />
  )
}

function BulkDeleteUsersDialog({ users, liveSessions, disabled, onClose, onConfirm }: {
  users: User[] | null
  liveSessions: { user: string }[]
  disabled: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  if (!users || users.length === 0) {
    return null
  }
  const usernames = new Set(users.map(user => user.username))
  const sessionCount = liveSessions.filter(session => usernames.has(session.user)).length
  const hasSessions = sessionCount > 0
  return (
    <DeleteWithReferencesDialog
      open
      width={460}
      title={t('users.bulkDelete.title', { count: users.length })}
      body={t('users.bulkDelete.body')}
      warning={hasSessions
        ? {
            title: t('users.bulkDelete.warnTitle'),
            body: t('users.bulkDelete.warnBody', { sessions: sessionCount }),
          }
        : null}
      hasReferences={hasSessions}
      isPending={disabled}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}
