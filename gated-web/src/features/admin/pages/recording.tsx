import type { RecordingMetadata } from '@/shared/lib/recordings'
import { format } from 'date-fns'
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { useRecordingCastQuery, useRecordingQuery } from '@/features/admin/api'
import { PageHeader } from '@/shared/components/page-header'
import { TerminalPlayer } from '@/shared/components/terminal-player'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { recordingMetadataToFieldSet, recordingTypeLabel } from '@/shared/lib/recordings'

function safeParseMetadata(raw: string): RecordingMetadata | null {
  try {
    return JSON.parse(raw) as RecordingMetadata
  }
  catch {
    return null
  }
}

export function Component() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation('admin')

  const recordingQuery = useRecordingQuery(id!)
  const recording = recordingQuery.data
  const isTerminal = recording?.kind === 'Terminal'

  const castQuery = useRecordingCastQuery(id!, isTerminal ?? false)

  if (recordingQuery.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('recording.title')} />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (recordingQuery.isError || !recording) {
    return (
      <div>
        <PageHeader title={t('recording.title')} />
        <p className="text-destructive text-sm">{t('recording.loadError')}</p>
      </div>
    )
  }

  const metadata = safeParseMetadata(recording.metadata)
  const metadataFields = metadata ? recordingMetadataToFieldSet(metadata) : []

  return (
    <div className="space-y-6">
      <PageHeader title={recording.name != null && recording.name !== '' ? recording.name : t('recording.title')} />

      {/* Metadata card */}
      <Card>
        <CardHeader>
          <CardTitle>{t('recording.metadata')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('recording.fields.type')}</dt>
            <dd>{recordingTypeLabel(recording.metadata)}</dd>

            <dt className="text-muted-foreground">{t('recording.fields.kind')}</dt>
            <dd>{recording.kind}</dd>

            <dt className="text-muted-foreground">{t('recording.fields.started')}</dt>
            <dd>{format(new Date(recording.started), 'PPpp')}</dd>

            {recording.ended != null && recording.ended !== '' && (
              <>
                <dt className="text-muted-foreground">{t('recording.fields.ended')}</dt>
                <dd>{format(new Date(recording.ended), 'PPpp')}</dd>
              </>
            )}

            <dt className="text-muted-foreground">{t('recording.fields.session')}</dt>
            <dd className="font-mono text-xs break-all">{recording.session_id}</dd>

            {metadataFields.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        </CardContent>
      </Card>

      {/* Terminal player card (only for Terminal recordings) */}
      {isTerminal && (
        <Card>
          <CardHeader>
            <CardTitle>{t('recording.player')}</CardTitle>
          </CardHeader>
          <CardContent>
            {castQuery.isLoading && <Skeleton className="h-64 w-full" />}
            {castQuery.isError && (
              <p className="text-destructive text-sm">{t('recording.castError')}</p>
            )}
            {castQuery.data != null && castQuery.data !== '' && (
              <TerminalPlayer castText={castQuery.data} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
