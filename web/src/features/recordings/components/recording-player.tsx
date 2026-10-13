import type { Recording } from '@/shared/lib/api/recordings'
import { Link, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, FileQuestion, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRecording } from '@/features/recordings/hooks/use-recording-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { ApiError } from '@/shared/lib/api/http'
import { Button } from '@/shared/ui/button'
import { HttpProxyPlayer } from './http-proxy-player'
import { SqlAuditPlayer } from './sql-audit-player'
import { TerminalPlayer } from './terminal-player'
import { TrafficPlayer } from './traffic-player'

export interface RecordingPlayerProps {
  recordingId: string
}

export function RecordingPlayer({ recordingId }: RecordingPlayerProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const query = useRecording(recordingId)

  const goBack = () => {
    void navigate({ to: '/admin/sessions' })
  }

  const breadcrumbs = [
    { label: t('section.admin') },
    { label: t('monitor.detail.breadcrumb'), to: '/admin/sessions' },
    { label: query.data?.name ?? recordingId },
  ]

  if (query.isPending) {
    return (
      <>
        <PageHeader
          title={t('recordings.dispatch.title')}
          breadcrumbs={breadcrumbs}
        />
        <div className="p-6">
          <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-sm text-muted-foreground"
          >
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            <span>{t('recordings.dispatch.loading')}</span>
          </div>
        </div>
      </>
    )
  }

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404
    return (
      <>
        <PageHeader
          title={t('recordings.dispatch.title')}
          breadcrumbs={breadcrumbs}
        />
        <div className="p-6">
          <EmptyState
            icon={notFound ? FileQuestion : AlertTriangle}
            title={t('recordings.dispatch.notFound')}
            description={t('recordings.dispatch.notFoundHint')}
            action={(
              <Button variant="outline" size="sm" onClick={goBack}>
                {t('recordings.dispatch.backToSessions')}
              </Button>
            )}
          />
        </div>
      </>
    )
  }

  const recording: Recording = query.data

  return (
    <>
      <PageHeader
        title={<span className="mono">{recording.name}</span>}
        breadcrumbs={breadcrumbs}
      />
      <div className="p-6">
        <RecordingBody recording={recording} />
      </div>
    </>
  )
}

function RecordingBody({ recording }: { recording: Recording }) {
  const { t } = useTranslation()
  switch (recording.kind) {
    case 'Terminal':
      return <TerminalPlayer recordingId={recording.id} live={!recording.ended} />
    case 'Traffic':
      return <TrafficPlayer recording={recording} />
    case 'HttpProxy':
      return <HttpProxyPlayer recordingId={recording.id} />
    case 'CommandAudit':
      return <Link to="/admin/command-records" className="underline">{t('nav.adminCommandRecords')}</Link>
    case 'SqlAudit':
      return <SqlAuditPlayer recording={recording} />
    default:
      return (
        <EmptyState
          icon={FileQuestion}
          title={t('recordings.dispatch.unknownKind')}
        />
      )
  }
}
