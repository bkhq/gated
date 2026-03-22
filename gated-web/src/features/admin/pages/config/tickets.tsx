import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { DataTable } from '@/shared/components/data-table'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { PageHeader } from '@/shared/components/page-header'
import { useTicketsQuery, useDeleteTicketMutation } from '@/features/admin/api'
import type { Ticket } from '@/features/admin/lib/api'

export function Component() {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const navigate = useNavigate()
  const { data: tickets = [], isLoading } = useTicketsQuery()
  const deleteMutation = useDeleteTicketMutation()
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const columns: ColumnDef<Ticket>[] = [
    {
      accessorKey: 'id',
      header: t('tickets.table.id'),
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.id.slice(0, 8)}...
        </span>
      ),
    },
    {
      accessorKey: 'username',
      header: t('tickets.table.username'),
    },
    {
      accessorKey: 'target',
      header: t('tickets.table.target'),
    },
    {
      accessorKey: 'description',
      header: t('tickets.table.description'),
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">
          {row.original.description || '—'}
        </span>
      ),
    },
    {
      accessorKey: 'uses_left',
      header: t('tickets.table.usesLeft'),
      cell: ({ row }) => <span>{row.original.uses_left ?? '∞'}</span>,
    },
    {
      accessorKey: 'expiry',
      header: t('tickets.table.expiry'),
      cell: ({ row }) => (
        <span className="text-sm">
          {row.original.expiry ? new Date(row.original.expiry).toLocaleString() : '—'}
        </span>
      ),
    },
    {
      accessorKey: 'created',
      header: t('tickets.table.created'),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.original.created).toLocaleString()}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={() => setDeleteId(row.original.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ),
    },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        {tc('actions.loading')}
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={t('pages.tickets')}
        actions={
          <Button onClick={() => void navigate('/@gated/admin/config/tickets/new')}>
            <Plus className="h-4 w-4 mr-2" />
            {t('tickets.create')}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={tickets}
        searchPlaceholder={tc('table.search')}
      />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={open => !open && setDeleteId(null)}
        title={tc('confirm.deleteTitle')}
        description={tc('confirm.deleteDescription')}
        confirmLabel={tc('actions.delete')}
        cancelLabel={tc('actions.cancel')}
        onConfirm={() => {
          if (deleteId) {
            deleteMutation.mutate(deleteId, {
              onSettled: () => setDeleteId(null),
            })
          }
        }}
      />
    </div>
  )
}
