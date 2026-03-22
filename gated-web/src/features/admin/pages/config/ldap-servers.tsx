import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Plus, Trash2 } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { toast } from 'sonner'
import { PageHeader } from '@/shared/components/page-header'
import { DataTable } from '@/shared/components/data-table'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import { useLdapServersQuery, useDeleteLdapServerMutation } from '@/features/admin/api'
import type { LdapServerResponse } from '@/features/admin/lib/api-client'

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const { data: servers = [], isLoading } = useLdapServersQuery()
  const deleteMutation = useDeleteLdapServerMutation()

  const handleDelete = async () => {
    if (!deleteId) return
    try {
      await deleteMutation.mutateAsync(deleteId)
      toast.success(t('ldap.deleted'))
    }
    catch {
      toast.error(t('ldap.deleteError'))
    }
    finally {
      setDeleteId(null)
    }
  }

  const columns: ColumnDef<LdapServerResponse>[] = [
    {
      accessorKey: 'name',
      header: t('ldap.columns.name'),
      cell: ({ row }) => (
        <button
          className="font-medium text-primary hover:underline text-left"
          onClick={() => navigate(row.original.id)}
        >
          {row.original.name}
        </button>
      ),
    },
    {
      id: 'url',
      header: t('ldap.columns.host'),
      cell: ({ row }) => (
        <span className="font-mono text-sm text-muted-foreground">
          {row.original.host}
          :
          {row.original.port}
        </span>
      ),
    },
    {
      accessorKey: 'tls_mode',
      header: t('ldap.columns.tls'),
      cell: ({ row }) => (
        <Badge variant={row.original.tls_mode === 'Disabled' ? 'secondary' : 'default'}>
          {row.original.tls_mode}
        </Badge>
      ),
    },
    {
      accessorKey: 'enabled',
      header: t('ldap.columns.status'),
      cell: ({ row }) => (
        <Badge variant={row.original.enabled ? 'default' : 'secondary'}>
          {row.original.enabled ? t('ldap.status.enabled') : t('ldap.status.disabled')}
        </Badge>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={e => {
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

  return (
    <div>
      <PageHeader
        title={t('pages.ldapServers')}
        description={t('ldap.description')}
        actions={(
          <Button onClick={() => navigate('new')}>
            <Plus className="h-4 w-4 mr-2" />
            {t('ldap.create')}
          </Button>
        )}
      />

      {isLoading
        ? (
            <p className="text-muted-foreground">{t('actions.loading', { ns: 'common' })}</p>
          )
        : servers.length === 0
          ? (
              <EmptyState
                title={t('ldap.emptyTitle')}
                description={t('ldap.emptyDescription')}
                action={(
                  <Button onClick={() => navigate('new')}>
                    <Plus className="h-4 w-4 mr-2" />
                    {t('ldap.create')}
                  </Button>
                )}
              />
            )
          : (
              <DataTable
                columns={columns}
                data={servers}
                searchPlaceholder={t('ldap.searchPlaceholder')}
              />
            )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={open => !open && setDeleteId(null)}
        title={t('ldap.deleteTitle')}
        description={t('ldap.deleteDescription')}
        confirmLabel={t('actions.delete', { ns: 'common' })}
        onConfirm={handleDelete}
      />
    </div>
  )
}
