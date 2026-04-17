import type { GetLogsRequest } from '@/features/admin/lib/api-client'
import type { FormValues } from './target-form'
import { format } from 'date-fns'
import { ChevronDown, ChevronRight, Key, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import {
  useAddTargetRole,
  useDeleteTarget,
  useLogsQuery,
  useRemoveTargetRole,
  useRoles,
  useTarget,
  useTargetGroupsQuery,
  useTargetRoles,
  useTargetSshHostKeys,
  useUpdateTarget,
} from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { buildRequest, TargetForm, targetToFormValues } from './target-form'

// ── Roles Tab ─────────────────────────────────────────────────────────────────

function RolesTab({ targetId }: { targetId: string }) {
  const { t } = useTranslation('admin')
  const [selectedRoleId, setSelectedRoleId] = useState('')

  const { data: assignedRoles, isLoading: rolesLoading } = useTargetRoles(targetId)
  const { data: allRoles } = useRoles()
  const addRole = useAddTargetRole()
  const removeRole = useRemoveTargetRole()

  const assignedIds = new Set(assignedRoles?.map(r => r.id) ?? [])
  const availableRoles = allRoles?.filter(r => !assignedIds.has(r.id)) ?? []

  function handleAdd() {
    if (selectedRoleId === '')
      return
    addRole.mutate(
      { targetId, roleId: selectedRoleId },
      { onSuccess: () => setSelectedRoleId('') },
    )
  }

  if (rolesLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Add role row */}
      <div className="flex gap-2">
        <Select value={selectedRoleId} onValueChange={v => setSelectedRoleId(v ?? '')}>
          <SelectTrigger className="flex-1 max-w-xs">
            <SelectValue placeholder={t('targets.roles.addPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {availableRoles.map(r => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={handleAdd}
          disabled={selectedRoleId === '' || addRole.isPending}
          size="sm"
        >
          {addRole.isPending
            ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              )
            : (
                <Plus className="h-4 w-4" />
              )}
          <span className="ml-1">{t('targets.roles.add')}</span>
        </Button>
      </div>

      {/* Assigned roles list */}
      {assignedRoles == null || assignedRoles.length === 0
        ? (
            <EmptyState
              icon={Key}
              title={t('targets.roles.empty')}
              description={t('targets.roles.emptyDescription')}
            />
          )
        : (
            <ul className="space-y-2">
              {assignedRoles.map(role => (
                <li
                  key={role.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div>
                    <span className="font-medium text-sm">{role.name}</span>
                    {role.description && (
                      <span className="ml-2 text-xs text-muted-foreground">{role.description}</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    disabled={removeRole.isPending}
                    onClick={() => removeRole.mutate({ targetId, roleId: role.id })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}

// ── SSH Host Keys Tab ─────────────────────────────────────────────────────────

function SshHostKeysTab({ targetId }: { targetId: string }) {
  const { t } = useTranslation('admin')
  const { data: hostKeys, isLoading } = useTargetSshHostKeys(targetId, true)

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (hostKeys == null || hostKeys.length === 0) {
    return (
      <EmptyState
        icon={Key}
        title={t('targets.sshHostKeys.empty')}
        description={t('targets.sshHostKeys.emptyDescription')}
      />
    )
  }

  return (
    <ul className="space-y-2">
      {hostKeys.map(key => (
        <li key={key.id} className="rounded-md border px-3 py-2 space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{key.key_type}</Badge>
            <span className="text-sm font-medium">
              {key.host}
              :
              {key.port}
            </span>
          </div>
          <p className="font-mono text-xs text-muted-foreground break-all">{key.key_base64}</p>
        </li>
      ))}
    </ul>
  )
}

// ── Logs Tab ─────────────────────────────────────────────────────────────────

type TimeRange = 'all' | '1h' | '24h' | '7d'

function getAfterTime(range: TimeRange): string | undefined {
  const now = new Date()
  if (range === '1h')
    return new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  if (range === '24h')
    return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  if (range === '7d')
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  return undefined
}

const LOG_PAGE_SIZE = 50

function TargetLogsTab({ targetName }: { targetName: string }) {
  const { t } = useTranslation('admin')

  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [searchFilter, setSearchFilter] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)

  const params: GetLogsRequest = useMemo(() => ({
    after: getAfterTime(timeRange),
    search: searchFilter || undefined,
    target_name: targetName,
    limit: 500,
  }), [timeRange, searchFilter, targetName])

  const { data: logs = [], isLoading, isFetching, refetch } = useLogsQuery(params)

  const totalPages = Math.max(1, Math.ceil(logs.length / LOG_PAGE_SIZE))
  const pagedLogs = logs.slice(page * LOG_PAGE_SIZE, (page + 1) * LOG_PAGE_SIZE)

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id))
        next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={timeRange} onValueChange={(v) => { setTimeRange(v as TimeRange); setPage(0) }}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1h">{t('log.last1h')}</SelectItem>
            <SelectItem value="24h">{t('log.last24h')}</SelectItem>
            <SelectItem value="7d">{t('log.last7d')}</SelectItem>
            <SelectItem value="all">{t('log.all')}</SelectItem>
          </SelectContent>
        </Select>

        <Input
          placeholder={t('log.search')}
          value={searchFilter}
          onChange={(e) => { setSearchFilter(e.target.value); setPage(0) }}
          className="w-56"
        />

        <Button
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>

        {!isLoading && (
          <span className="text-sm text-muted-foreground ml-auto">
            {t('log.showing', { count: logs.length })}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-44">{t('log.columns.timestamp')}</TableHead>
              <TableHead className="w-32">{t('log.columns.username')}</TableHead>
              <TableHead>{t('log.columns.message')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={4}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : pagedLogs.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                        {t('log.noLogs')}
                      </TableCell>
                    </TableRow>
                  )
                : pagedLogs.map((entry) => {
                    const isExpanded = expandedIds.has(entry.id)
                    return (
                      <Fragment key={entry.id}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => toggleExpand(entry.id)}
                        >
                          <TableCell className="text-muted-foreground">
                            {isExpanded
                              ? <ChevronDown className="h-4 w-4" />
                              : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                            {format(new Date(entry.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                          </TableCell>
                          <TableCell>
                            {entry.username != null && entry.username !== ''
                              ? <Badge variant="secondary">{entry.username}</Badge>
                              : <span className="text-muted-foreground text-sm">—</span>}
                          </TableCell>
                          <TableCell className="text-sm">{entry.text}</TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell />
                            <TableCell colSpan={3} className="py-3">
                              <pre className="text-xs font-mono bg-background rounded border p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                {JSON.stringify(entry.values, null, 2)}
                              </pre>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {!isLoading && logs.length > LOG_PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {page * LOG_PAGE_SIZE + 1}
            –
            {Math.min((page + 1) * LOG_PAGE_SIZE, logs.length)}
            {' '}
            /
            {logs.length}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
            >
              {t('log.prev')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p + 1)}
              disabled={page >= totalPages - 1}
            >
              {t('log.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function Component() {
  const { t } = useTranslation('admin')
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { data: target, isLoading } = useTarget(id ?? '')
  const { data: groups = [] } = useTargetGroupsQuery()
  const updateMutation = useUpdateTarget()
  const deleteMutation = useDeleteTarget()

  function onSubmit(values: FormValues) {
    if (id == null || id === '')
      return
    updateMutation.mutate({ id, req: buildRequest(values) })
  }

  function handleDelete() {
    if (id == null || id === '')
      return
    deleteMutation.mutate(id, {
      onSuccess: () => void navigate('/ui/admin/config/targets'),
    })
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-64 w-full max-w-2xl" />
      </div>
    )
  }

  if (!target) {
    return (
      <EmptyState
        title={t('targets.notFound')}
        description={t('targets.emptyDescription')}
        action={(
          <Button variant="outline" onClick={() => void navigate('/ui/admin/config/targets')}>
            {t('targets.title')}
          </Button>
        )}
      />
    )
  }

  const isSsh = target.options.kind === 'Ssh'

  return (
    <div>
      <PageHeader
        title={target.name}
        description={target.description || undefined}
        actions={(
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('common.delete')}
          </Button>
        )}
      />

      <Tabs defaultValue="details" className="space-y-4">
        <TabsList>
          <TabsTrigger value="details">{t('targets.tabs.details')}</TabsTrigger>
          <TabsTrigger value="roles">{t('targets.tabs.roles')}</TabsTrigger>
          {isSsh && <TabsTrigger value="ssh-keys">{t('targets.tabs.sshHostKeys')}</TabsTrigger>}
          <TabsTrigger value="logs">{t('targets.tabs.logs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <div className="max-w-2xl">
            <TargetForm
              defaultValues={targetToFormValues(target)}
              groups={groups}
              onSubmit={onSubmit}
              isSubmitting={updateMutation.isPending}
              submitLabel={t('targets.saveChanges')}
            />
          </div>
        </TabsContent>

        <TabsContent value="roles">
          <div className="max-w-2xl">
            <RolesTab targetId={target.id} />
          </div>
        </TabsContent>

        {isSsh && (
          <TabsContent value="ssh-keys">
            <div className="max-w-2xl">
              <SshHostKeysTab targetId={target.id} />
            </div>
          </TabsContent>
        )}

        <TabsContent value="logs">
          <TargetLogsTab targetName={target.name} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('targets.deleteTitle')}
        description={t('targets.deleteDescription')}
        confirmLabel={t('common.delete')}
        onConfirm={handleDelete}
      />
    </div>
  )
}
