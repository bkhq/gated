import type { Recording } from '@/shared/lib/api/recordings'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Activity, Download, Eye, FileText, Play } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RecordingPlayer } from '@/features/recordings/components/recording-player'
import { useSessionRecordings } from '@/features/recordings/hooks/use-recording-queries'
import {
  useSession,
} from '@/features/sessions/hooks/use-sessions-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { recordingCastUrl, recordingTcpdumpUrl } from '@/shared/lib/api/recordings'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'

const detailRoute = getRouteApi('/admin/sessions/$sessionId')

function recordingDownloadUrl(recording: Recording): string | null {
  switch (recording.kind) {
    case 'Traffic': return recordingTcpdumpUrl(recording.id)
    case 'Terminal': return recordingCastUrl(recording.id)
    case 'HttpProxy':
    case 'SqlAudit':
    case 'CommandAudit':
      return null
  }
}

function recordingDownloadFilename(recording: Recording): string {
  switch (recording.kind) {
    case 'Traffic': return `${recording.name}.pcap`
    case 'Terminal': return `${recording.name}.cast`
    case 'HttpProxy':
    case 'SqlAudit':
    case 'CommandAudit':
      return recording.name
  }
}
export function AdminSessionDetailPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { sessionId } = detailRoute.useParams()
  const sessionQuery = useSession(sessionId)
  const session = sessionQuery.data
  const recordingsQuery = useSessionRecordings(sessionId)
  const recordings = recordingsQuery.data ?? []
  const latestRecording = recordings[0]
  const hasRecordings = recordings.length > 0
  const recordingsLoading = recordingsQuery.isLoading
  const headerDownloadUrl = latestRecording ? recordingDownloadUrl(latestRecording) : null
  const headerDownloadFilename = latestRecording ? recordingDownloadFilename(latestRecording) : ''

  const goBack = React.useCallback(() => {
    void navigate({ to: '/admin/sessions' })
  }, [navigate])

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        goBack()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [goBack])

  if (sessionQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">{t('targets.detail.loading')}</div>
  }

  if (!session) {
    return (
      <>
        <PageHeader
          title={<span className="mono">{sessionId}</span>}
          breadcrumbs={[
            { label: t('section.admin') },
            { label: t('monitor.detail.breadcrumb'), to: '/admin/sessions' },
            { label: sessionId },
          ]}
        />
        <div className="p-10">
          <EmptyState
            title={t('monitor.detail.notFoundTitle')}
            description={t('monitor.detail.notFoundDescription')}
            action={(
              <Button variant="outline" size="sm" onClick={goBack}>
                {t('actions.back')}
              </Button>
            )}
          />
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={<span className="mono">{session.id}</span>}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('monitor.detail.breadcrumb'), to: '/admin/sessions' },
          { label: session.id },
        ]}
        actions={(
          <>
            {session.state === 'live'
              ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { void navigate({ to: '/admin/sessions/$sessionId/monitor', params: { sessionId: session.id } }) }}
                  >
                    <Eye size={13} />
                    <span>{t('monitor.sessions.actions.watchLive')}</span>
                  </Button>
                )
              : null}
            {headerDownloadUrl !== null
              ? (
                  <a
                    href={headerDownloadUrl}
                    download={headerDownloadFilename}
                    className="focus-ring inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground no-underline transition hover:bg-muted active:translate-y-px"
                  >
                    <Download size={13} aria-hidden="true" />
                    <span>{t('monitor.detail.actions.downloadRecording')}</span>
                  </a>
                )
              : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!hasRecordings || recordingsLoading}
                    title={hasRecordings && latestRecording ? t('monitor.detail.actions.downloadUnsupportedKind', { kind: latestRecording.kind }) : undefined}
                  >
                    <Download size={13} />
                    <span>{t('monitor.detail.actions.downloadRecording')}</span>
                  </Button>
                )}
            <Button
              size="sm"
              disabled={!hasRecordings || recordingsLoading}
              onClick={() => {
                if (latestRecording) {
                  void navigate({ to: '/admin/recordings/$recordingId', params: { recordingId: latestRecording.id } })
                }
              }}
            >
              <Play size={13} />
              <span>{t('monitor.detail.actions.replay')}</span>
            </Button>
          </>
        )}
      />

      <div className="grid gap-4 px-6 pb-6 pt-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('monitor.detail.timelineTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              icon={Activity}
              title={t('monitor.detail.timelineEmpty')}
              description={t('monitor.detail.timelineEmptyHint')}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('monitor.detail.detailsTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
                <DetailRow label={t('fields.user')}>
                  <div className="flex items-center gap-2">
                    <Avatar name={session.user} size={20} />
                    <span>{session.user}</span>
                  </div>
                </DetailRow>
                <DetailRow label={t('fields.target')}>
                  <span className="mono">{session.target}</span>
                </DetailRow>
                <DetailRow label={t('fields.protocol')}>
                  <Badge tone="mono">{session.protocol}</Badge>
                </DetailRow>
                <DetailRow label={t('fields.started')}>
                  <span className="mono">{session.started}</span>
                </DetailRow>
                <DetailRow label={t('fields.duration')}>
                  <span className="mono">{session.duration}</span>
                </DetailRow>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('monitor.detail.recordingsTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              {recordingsLoading
                ? <div className="text-[13px] text-muted-foreground">{t('recordings.dispatch.loading')}</div>
                : hasRecordings
                  ? (
                      <div className="flex flex-col gap-2">
                        {recordings.map(recording => (
                          <RecordingItem key={recording.id} recording={recording} />
                        ))}
                      </div>
                    )
                  : (
                      <EmptyState
                        icon={FileText}
                        title={t('monitor.detail.recordingPurged')}
                        description={t('monitor.detail.recordingPurgedHint')}
                      />
                    )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

function DetailRow({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="m-0">{children}</dd>
    </>
  )
}

function RecordingItem({ recording }: { recording: Recording }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const downloadUrl = recordingDownloadUrl(recording)
  const downloadFilename = recordingDownloadFilename(recording)
  const startedLabel = formatRecordingStarted(recording.started)
  const openRecording = () => {
    void navigate({ to: '/admin/recordings/$recordingId', params: { recordingId: recording.id } })
  }
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
      <button
        type="button"
        onClick={openRecording}
        className="focus-ring -m-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-sm p-1 text-left transition hover:bg-muted"
        aria-label={t('a11y.admin.monitor.sessions.openRecording', { name: recording.name })}
      >
        <FileText size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="mono truncate text-[13px]">{recording.name}</div>
          <div className="text-[11.5px] text-muted-foreground">
            {recording.kind}
            {startedLabel === null ? '' : ` · ${startedLabel}`}
          </div>
        </div>
      </button>
      {downloadUrl === null
        ? (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled
              aria-label={t('a11y.admin.monitor.sessions.downloadRecording', { name: recording.name })}
              title={t('monitor.detail.actions.downloadUnsupportedKind', { kind: recording.kind })}
            >
              <Download size={13} aria-hidden="true" />
            </Button>
          )
        : (
            <a
              href={downloadUrl}
              download={downloadFilename}
              className="focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t('a11y.admin.monitor.sessions.downloadRecording', { name: recording.name })}
            >
              <Download size={13} aria-hidden="true" />
            </a>
          )}
    </div>
  )
}

function formatRecordingStarted(value: string): string | null {
  if (value.length === 0)
    return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return value
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const recordingRoute = getRouteApi('/admin/recordings/$recordingId')

export function AdminRecordingPage() {
  const { recordingId } = recordingRoute.useParams()
  return <RecordingPlayer recordingId={recordingId} />
}
