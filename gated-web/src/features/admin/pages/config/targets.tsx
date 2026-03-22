import { useState } from 'react'
import { Link } from 'react-router'
import { Plus, Pencil, Trash2, Server } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { PageHeader } from '@/shared/components/page-header'
import { DataTable } from '@/shared/components/data-table'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import type { Target } from '@/features/admin/lib/api'
import { useTargets, useTargetGroupsQuery, useDeleteTarget } from '@/features/admin/api'

const TYPE_LABELS: Record<string, string> = {
  Ssh: 'SSH',
  Kubernetes: 'Kubernetes',
  MySql: 'MySQL',
  Postgres: 'PostgreSQL',
  WebAdmin: 'Web Admin',
  Api: 'API',
}

export function Component() {
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
      header: 'Name',
      cell: ({ row }) => (
        <Link
          to={`/@gated/admin/config/targets/${row.original.id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: 'type',
      accessorFn: row => TYPE_LABELS[row.options.kind] ?? row.options.kind,
      header: 'Type',
      cell: ({ row }) => (
        <Badge variant="secondary">
          {TYPE_LABELS[row.original.options.kind] ?? row.original.options.kind}
        </Badge>
      ),
    },
    {
      id: 'description',
      accessorKey: 'description',
      header: 'Description',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
    {
      id: 'group',
      accessorFn: row =>
        row.group_id ? (groupMap.get(row.group_id) ?? row.group_id) : '',
      header: 'Group',
      cell: ({ row }) => {
        const name = row.original.group_id ? groupMap.get(row.original.group_id) : undefined
        return <span className="text-muted-foreground">{name ?? '—'}</span>
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" asChild>
            <Link to={`/@gated/admin/config/targets/${row.original.id}`}>
              <Pencil className="h-4 w-4" />
            </Link>
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

  const targetToDelete = targets?.find(t => t.id === deleteId)

  return (
    <div>
      <PageHeader
        title="Targets"
        description="Manage connection targets"
        actions={
          <Button asChild>
            <Link to="/@gated/admin/config/targets/new">
              <Plus className="mr-2 h-4 w-4" />
              Create Target
            </Link>
          </Button>
        }
      />

      <div className="mb-4">
        <Select value={groupId || 'all'} onValueChange={val => setGroupId(val === 'all' ? '' : val)}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All groups" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All groups</SelectItem>
            {groups?.map(g => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !targets?.length ? (
        <EmptyState
          icon={Server}
          title="No targets"
          description="Create your first connection target to get started."
          action={
            <Button asChild>
              <Link to="/@gated/admin/config/targets/new">
                <Plus className="mr-2 h-4 w-4" />
                Create Target
              </Link>
            </Button>
          }
        />
      ) : (
        <DataTable columns={columns} data={targets} searchPlaceholder="Search targets..." />
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={open => {
          if (!open) setDeleteId(null)
        }}
        title="Delete Target"
        description={`Are you sure you want to delete "${targetToDelete?.name ?? ''}"? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteId) {
            deleteMutation.mutate(deleteId, { onSuccess: () => setDeleteId(null) })
          }
        }}
      />
    </div>
  )
}
