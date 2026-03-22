import { type ColumnDef } from '@tanstack/react-table'
import { Layers, MoreHorizontal, Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useState } from 'react'
import { useTargetGroupsQuery, useDeleteTargetGroupMutation } from '@/features/admin/api'
import { type TargetGroup } from '@/features/admin/lib/api'
import { DataTable } from '@/shared/components/data-table'
import { PageHeader } from '@/shared/components/page-header'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'

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
  const navigate = useNavigate()
  const { data: groups, isLoading } = useTargetGroupsQuery()
  const deleteGroup = useDeleteTargetGroupMutation()
  const [deleteTarget, setDeleteTarget] = useState<TargetGroup | null>(null)

  const columns: ColumnDef<TargetGroup>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <Link
          to={`/@gated/ui/admin/config/target-groups/${row.original.id}`}
          className="font-medium hover:underline flex items-center gap-2"
        >
          <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'description',
      header: 'Description',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
    {
      accessorKey: 'color',
      header: 'Color',
      cell: ({ row }) => {
        const color = row.original.color
        if (!color) return <span className="text-muted-foreground">—</span>
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
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  navigate(`/@gated/ui/admin/config/target-groups/${row.original.id}`)
                }
              >
                View details
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setDeleteTarget(row.original)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ]

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteGroup.mutateAsync(deleteTarget.id)
      toast.success(`Target group "${deleteTarget.name}" deleted`)
    } catch {
      toast.error('Failed to delete target group')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Target Groups"
        description="Organize targets into named groups"
        actions={
          <Button asChild>
            <Link to="/@gated/ui/admin/config/target-groups/new">
              <Plus className="h-4 w-4 mr-2" />
              New Group
            </Link>
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={groups ?? []}
          searchPlaceholder="Search target groups..."
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={`Delete group "${deleteTarget?.name}"?`}
        description="This will permanently delete the target group."
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  )
}
