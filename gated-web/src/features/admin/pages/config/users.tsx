import { type ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Plus, UserCircle } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useUsers, useDeleteUser } from '@/features/admin/api'
import { type User } from '@/features/admin/lib/api'
import { DataTable } from '@/shared/components/data-table'
import { PageHeader } from '@/shared/components/page-header'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useState } from 'react'

export function Component() {
  const navigate = useNavigate()
  const { data: users, isLoading } = useUsers()
  const deleteUser = useDeleteUser()
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)

  const columns: ColumnDef<User>[] = [
    {
      accessorKey: 'username',
      header: 'Username',
      cell: ({ row }) => (
        <Link
          to={`/ui/admin/config/users/${row.original.id}`}
          className="font-medium hover:underline flex items-center gap-2"
        >
          <UserCircle className="h-4 w-4 text-muted-foreground shrink-0" />
          {row.original.username}
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
      id: 'ldap',
      header: 'LDAP',
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">
          {row.original.ldap_server_id ? 'Linked' : '—'}
        </span>
      ),
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
              <DropdownMenuItem onClick={() => navigate(`/ui/admin/config/users/${row.original.id}`)}>
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
      await deleteUser.mutateAsync(deleteTarget.id)
      toast.success(`User "${deleteTarget.username}" deleted`)
    } catch {
      toast.error('Failed to delete user')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Users"
        description="Manage user accounts and credentials"
        actions={
          <Button asChild>
            <Link to="/ui/admin/config/users/new">
              <Plus className="h-4 w-4 mr-2" />
              New User
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
          data={users ?? []}
          searchPlaceholder="Search users..."
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={`Delete user "${deleteTarget?.username}"?`}
        description="This will permanently delete the user and all their credentials."
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  )
}
