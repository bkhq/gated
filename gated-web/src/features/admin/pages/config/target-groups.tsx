import type { ColumnDef } from '@tanstack/react-table'
import type { TargetGroup } from '@/features/admin/lib/api'
import { Layers, MoreHorizontal, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useDeleteTargetGroupMutation, useTargetGroupsQuery } from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { DataTable } from '@/shared/components/data-table'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { Skeleton } from '@/shared/components/ui/skeleton'

const colorClassMap: Record<string, string> = {
  Primary: 'bg-blue-500 text-white',
  Secondary: 'bg-gray-500 text-white',
  Success: 'bg-green-500 text-white',
  Danger: 'bg-red-500 text-white',
  Warning: 'bg-yellow-500 text-white',
  Info: 'bg-cyan-500 text-white',
  Light: 'bg-gray-100 text-gray-800',
  Dark: 'bg-gray-800 text-white',
}

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const { data: groups, isLoading } = useTargetGroupsQuery()
  const deleteGroup = useDeleteTargetGroupMutation()
  const [deleteTarget, setDeleteTarget] = useState<TargetGroup | null>(null)

  const columns: ColumnDef<TargetGroup>[] = [
    {
      accessorKey: 'name',
      header: t('admin:targetGroups.columns.name'),
      cell: ({ row }) => (
        <Link
          to={`/ui/admin/config/target-groups/${row.original.id}`}
          className="font-medium hover:underline flex items-center gap-2"
        >
          <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'description',
      header: t('admin:targetGroups.columns.description'),
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
    {
      accessorKey: 'color',
      header: t('admin:targetGroups.columns.color'),
      cell: ({ row }) => {
        const color = row.original.color
        if (color == null)
          return <span className="text-muted-foreground">—</span>
        return (
          <Badge className={colorClassMap[color] ?? ''}>
            {color}
          </Badge>
        )
      },
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-8 w-8 p-0" />}>
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  void navigate(`/ui/admin/config/target-groups/${row.original.id}`)}
              >
                {t('admin:targetGroups.actions.viewDetails')}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setDeleteTarget(row.original)}
              >
                {t('admin:common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ]

  async function handleDelete() {
    if (deleteTarget == null)
      return
    try {
      await deleteGroup.mutateAsync(deleteTarget.id)
      toast.success(t('admin:targetGroups.deleted', { name: deleteTarget.name }))
    }
    catch {
      toast.error(t('admin:targetGroups.deleteError'))
    }
    finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div>
      <PageHeader
        title={t('admin:targetGroups.title')}
        description={t('admin:targetGroups.description')}
        actions={(
          <Button render={<Link to="/ui/admin/config/target-groups/new" />}>
            <Plus className="h-4 w-4 mr-2" />
            {t('admin:targetGroups.create')}
          </Button>
        )}
      />

      {isLoading
        ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )
        : (
            <DataTable
              columns={columns}
              data={groups ?? []}
              searchPlaceholder={t('admin:targetGroups.searchPlaceholder')}
            />
          )}

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={t('admin:targetGroups.deleteTitle', { name: deleteTarget?.name })}
        description={t('admin:targetGroups.deleteDescription')}
        confirmLabel={t('admin:common.delete')}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}
