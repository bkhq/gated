import type { ColumnDef } from '@tanstack/react-table'
import type { Target, TargetOptions } from '@/features/admin/lib/api'
import { Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useDeleteTarget, useTargetGroupsQuery, useTargets } from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { DataTable } from '@/shared/components/data-table'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { TableSkeleton } from '@/shared/components/table-skeleton'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { cn } from '@/shared/lib/utils'

const TYPE_CLASS: Record<string, string> = {
  Ssh: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  Kubernetes: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  MySql: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  Postgres: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  WebAdmin: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  Api: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
}

function getAddress(options: TargetOptions): string {
  switch (options.kind) {
    case 'Ssh':
      return `${options.host}:${options.port}`
    case 'MySql':
      return `${options.host}:${options.port}`
    case 'Postgres':
      return `${options.host}:${options.port}`
    case 'Kubernetes':
      return options.cluster_url
    case 'Api':
      return options.url
    case 'WebAdmin':
      return '—'
  }
}

export function Component() {
  const { t } = useTranslation('admin')
  const [groupId, setGroupId] = useState<string>('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const { data: targets, isLoading } = useTargets({ group_id: groupId || undefined })
  const { data: groups } = useTargetGroupsQuery()
  const deleteMutation = useDeleteTarget()

  const groupMap = new Map(groups?.map(g => [g.id, g.name]) ?? [])

  const columns: ColumnDef<Target>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: t('targets.columns.name'),
      cell: ({ row }) => (
        <Link
          to={`/ui/admin/config/targets/${row.original.id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: 'type',
      accessorFn: row => t(`targets.types.${row.options.kind}`, row.options.kind),
      header: t('targets.columns.type'),
      cell: ({ row }) => {
        const kind = row.original.options.kind
        return (
          <Badge
            variant="outline"
            className={cn('font-medium', TYPE_CLASS[kind])}
          >
            {t(`targets.types.${kind}`, kind)}
          </Badge>
        )
      },
    },
    {
      id: 'address',
      accessorFn: row => getAddress(row.options),
      header: t('targets.columns.address'),
      cell: ({ row }) => (
        <span className="font-mono text-sm text-muted-foreground">
          {getAddress(row.original.options)}
        </span>
      ),
    },
    {
      id: 'group',
      accessorFn: row => row.group_id != null && row.group_id !== '' ? (groupMap.get(row.group_id) ?? row.group_id) : '',
      header: t('targets.columns.group'),
      cell: ({ row }) => {
        const name = row.original.group_id != null && row.original.group_id !== '' ? groupMap.get(row.original.group_id) : undefined
        return <span className="text-muted-foreground">{name ?? '—'}</span>
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" render={<Link to={`/ui/admin/config/targets/${row.original.id}`} />}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteId(row.original.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('targets.title')}
        description={t('targets.description')}
        actions={(
          <Button render={<Link to="/ui/admin/config/targets/new" />}>
            <Plus className="mr-2 h-4 w-4" />
            {t('targets.create')}
          </Button>
        )}
      />

      <div className="mb-4">
        <Select value={groupId || 'all'} onValueChange={val => setGroupId((val ?? 'all') === 'all' ? '' : (val ?? 'all'))}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder={t('targets.allGroups')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('targets.allGroups')}</SelectItem>
            {groups?.map(g => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading
        ? (
            <TableSkeleton columns={5} rows={5} />
          )
        : targets == null || targets.length === 0
          ? (
              <EmptyState
                icon={Server}
                title={t('targets.empty')}
                description={t('targets.emptyDescription')}
                action={(
                  <Button render={<Link to="/ui/admin/config/targets/new" />}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t('targets.create')}
                  </Button>
                )}
              />
            )
          : (
              <DataTable
                columns={columns}
                data={targets}
                searchPlaceholder={t('targets.searchPlaceholder')}
              />
            )}

      <ConfirmDialog
        open={deleteId != null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteId(null)
        }}
        title={t('targets.deleteTitle')}
        description={t('targets.deleteDescription')}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (deleteId != null) {
            deleteMutation.mutate(deleteId, { onSuccess: () => setDeleteId(null) })
          }
        }}
      />
    </div>
  )
}
