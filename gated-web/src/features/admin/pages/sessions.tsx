import type { ColumnDef } from '@tanstack/react-table'
import type { SessionSnapshot } from '@/features/admin/lib/api'
import { Eye, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  useCleanSessionsMutation,
  useCloseSessionMutation,
  useSessionsQuery,
} from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { DataTable } from '@/shared/components/data-table'
import { PageHeader } from '@/shared/components/page-header'
import { StatusBadge } from '@/shared/components/status-badge'
import { TableSkeleton } from '@/shared/components/table-skeleton'
import { Button } from '@/shared/components/ui/button'
import { Label } from '@/shared/components/ui/label'
import { Switch } from '@/shared/components/ui/switch'

export function Component() {
  const { t } = useTranslation('admin')
  const navigate = useNavigate()
  const [activeOnly, setActiveOnly] = useState(true)
  const [closeTarget, setCloseTarget] = useState<SessionSnapshot | null>(null)
  const [cleanAllOpen, setCleanAllOpen] = useState(false)

  const { data, isLoading } = useSessionsQuery(activeOnly)
  const closeMutation = useCloseSessionMutation()
  const cleanMutation = useCleanSessionsMutation()

  const sessions = data?.items ?? []

  const columns: ColumnDef<SessionSnapshot>[] = [
    {
      accessorKey: 'username',
      header: t('sessions.columns.username'),
      cell: ({ row }) => row.original.username ?? '—',
    },
    {
      id: 'target',
      header: t('sessions.columns.target'),
      cell: ({ row }) => row.original.target?.name ?? '—',
    },
    {
      accessorKey: 'protocol',
      header: t('sessions.columns.protocol'),
      cell: ({ row }) => (
        <span className="capitalize">{row.original.protocol}</span>
      ),
    },
    {
      accessorKey: 'started',
      header: t('sessions.columns.started'),
      cell: ({ row }) => new Date(row.original.started).toLocaleString(),
    },
    {
      id: 'status',
      header: t('sessions.columns.status'),
      cell: ({ row }) => {
        const isActive = row.original.ended == null || row.original.ended === ''
        return (
          <StatusBadge
            status={isActive ? 'active' : 'inactive'}
            label={isActive ? t('sessions.status.active') : t('sessions.status.ended')}
          />
        )
      },
    },
    {
      id: 'actions',
      header: t('sessions.columns.actions'),
      cell: ({ row }) => {
        const session = row.original
        const isActive = session.ended == null || session.ended === ''
        return (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigate(`/ui/admin/sessions/${session.id}`)}
              title={t('sessions.actions.viewDetail')}
            >
              <Eye className="h-4 w-4" />
            </Button>
            {isActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCloseTarget(session)}
                title={t('sessions.actions.close')}
              >
                <X className="h-4 w-4 text-destructive" />
              </Button>
            )}
          </div>
        )
      },
    },
  ]

  function handleCloseSession() {
    if (!closeTarget)
      return
    closeMutation.mutate(closeTarget.id, {
      onSuccess: () => {
        toast.success(t('sessions.actions.closeSuccess'))
        setCloseTarget(null)
      },
      onError: () => {
        toast.error(t('sessions.actions.closeError'))
      },
    })
  }

  function handleCleanAll() {
    cleanMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('sessions.cleanAllSuccess'))
        setCleanAllOpen(false)
      },
      onError: () => {
        toast.error(t('sessions.cleanAllError'))
      },
    })
  }

  return (
    <div>
      <PageHeader
        title={t('sessions.title')}
        description={t('sessions.description')}
        actions={(
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setCleanAllOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {t('sessions.closeAll')}
          </Button>
        )}
      />

      <div className="flex items-center gap-2 mb-4">
        <Switch
          id="active-only"
          checked={activeOnly}
          onCheckedChange={setActiveOnly}
        />
        <Label htmlFor="active-only">{t('sessions.filterActive')}</Label>
      </div>

      {isLoading
        ? (
            <TableSkeleton columns={6} rows={5} />
          )
        : (
            <DataTable
              columns={columns}
              data={sessions}
              searchPlaceholder={t('sessions.searchPlaceholder')}
            />
          )}

      <ConfirmDialog
        open={!!closeTarget}
        onOpenChange={(open) => {
          if (!open)
            setCloseTarget(null)
        }}
        title={t('sessions.actions.closeConfirm')}
        description={t('sessions.actions.closeDescription')}
        confirmLabel={t('sessions.actions.close')}
        onConfirm={handleCloseSession}
      />

      <ConfirmDialog
        open={cleanAllOpen}
        onOpenChange={setCleanAllOpen}
        title={t('sessions.closeAllConfirm')}
        description={t('sessions.closeAllDescription')}
        confirmLabel={t('sessions.closeAll')}
        onConfirm={handleCleanAll}
      />
    </div>
  )
}
