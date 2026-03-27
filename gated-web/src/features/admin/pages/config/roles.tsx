import type { ColumnDef } from '@tanstack/react-table'
import type { Role } from '@/features/admin/lib/api-client'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useDeleteRoleMutation, useRoles } from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { DataTable } from '@/shared/components/data-table'
import { PageHeader } from '@/shared/components/page-header'
import { Button } from '@/shared/components/ui/button'

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const { data: roles = [], isLoading } = useRoles()
  const deleteMutation = useDeleteRoleMutation()

  const columns: ColumnDef<Role>[] = [
    {
      accessorKey: 'name',
      header: t('roles.name'),
      cell: ({ row }) => (
        <button
          className="font-medium text-primary hover:underline text-left"
          onClick={() => void navigate(row.original.id)}
        >
          {row.original.name}
        </button>
      ),
    },
    {
      accessorKey: 'description',
      header: t('roles.description'),
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              setDeleteId(row.original.id)
            }}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  const handleDelete = async () => {
    if (deleteId == null)
      return
    try {
      await deleteMutation.mutateAsync(deleteId)
      toast.success(t('roles.deleted'))
    }
    catch {
      toast.error(t('roles.deleteError'))
    }
    finally {
      setDeleteId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title={t('pages.roles')}
        actions={(
          <Button onClick={() => void navigate('new')}>
            <Plus className="h-4 w-4 mr-2" />
            {t('roles.create')}
          </Button>
        )}
      />

      {isLoading
        ? (
            <p className="text-muted-foreground">{t('actions.loading', { ns: 'common' })}</p>
          )
        : (
            <DataTable
              columns={columns}
              data={roles}
              searchPlaceholder={t('roles.searchPlaceholder')}
            />
          )}

      <ConfirmDialog
        open={deleteId != null}
        onOpenChange={open => !open && setDeleteId(null)}
        title={t('roles.deleteTitle')}
        description={t('roles.deleteDescription')}
        confirmLabel={t('actions.delete', { ns: 'common' })}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}
