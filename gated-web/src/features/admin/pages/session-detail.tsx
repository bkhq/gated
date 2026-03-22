import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate, Link } from 'react-router'
import { ArrowLeft, X, Film } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { StatusBadge } from '@/shared/components/status-badge'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import {
  useSessionQuery,
  useSessionRecordingsQuery,
  useCloseSessionMutation,
} from '@/features/admin/api'

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start">
      <span className="text-sm font-medium text-muted-foreground min-w-[140px]">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  )
}

export function Component() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation('admin')
  const navigate = useNavigate()
  const [closeOpen, setCloseOpen] = useState(false)

  const { data: session, isLoading: sessionLoading } = useSessionQuery(id ?? '')
  const { data: recordings, isLoading: recordingsLoading } = useSessionRecordingsQuery(id ?? '')
  const closeMutation = useCloseSessionMutation()

  const isActive = session && !session.ended

  function handleClose() {
    if (!id) return
    closeMutation.mutate(id, {
      onSuccess: () => {
        toast.success(t('sessions.actions.closeSuccess'))
        setCloseOpen(false)
      },
      onError: () => {
        toast.error(t('sessions.actions.closeError'))
      },
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/@gated/admin')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('sessionDetail.back')}
        </Button>
        {isActive && (
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            onClick={() => setCloseOpen(true)}
          >
            <X className="h-4 w-4 mr-2" />
            {t('sessions.actions.close')}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('sessionDetail.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {sessionLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : session ? (
            <>
              <DetailRow
                label={t('sessionDetail.metadata.status')}
                value={
                  <StatusBadge
                    status={isActive ? 'active' : 'inactive'}
                    label={isActive ? t('sessions.status.active') : t('sessions.status.ended')}
                  />
                }
              />
              <DetailRow
                label={t('sessionDetail.metadata.user')}
                value={session.username ?? '—'}
              />
              <DetailRow
                label={t('sessionDetail.metadata.target')}
                value={session.target?.name ?? '—'}
              />
              <DetailRow
                label={t('sessionDetail.metadata.protocol')}
                value={<span className="capitalize">{session.protocol}</span>}
              />
              <DetailRow
                label={t('sessionDetail.metadata.started')}
                value={new Date(session.started).toLocaleString()}
              />
              <DetailRow
                label={t('sessionDetail.metadata.ended')}
                value={session.ended ? new Date(session.ended).toLocaleString() : '—'}
              />
              {session.ticket_id && (
                <DetailRow
                  label={t('sessionDetail.metadata.ticketId')}
                  value={session.ticket_id}
                />
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('sessionDetail.notFound')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('sessionDetail.recordings.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {recordingsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : recordings && recordings.length > 0 ? (
            <div className="space-y-2">
              {recordings.map((rec) => (
                <div
                  key={rec.id}
                  className="flex items-center justify-between rounded-md border px-4 py-2"
                >
                  <div className="flex items-center gap-3">
                    <Film className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{rec.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {rec.kind} · {new Date(rec.started).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/@gated/admin/recordings/${rec.id}`}>
                      {t('sessionDetail.recordings.view')}
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Film}
              title={t('sessionDetail.recordings.empty')}
            />
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title={t('sessions.actions.closeConfirm')}
        description={t('sessions.actions.closeDescription')}
        confirmLabel={t('sessions.actions.close')}
        onConfirm={handleClose}
      />
    </div>
  )
}
