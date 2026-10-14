import type { Recording } from '@/shared/lib/api/recordings'
import { Download, FileX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/shared/components/empty-state'
import { recordingTcpdumpUrl } from '@/shared/lib/api/recordings'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function formatTimestamp(value: string | null | undefined): string {
  if (value == null || value.length === 0)
    return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return value
  return timestampFormatter.format(date)
}

export function TrafficPlayer({ recording }: { recording: Recording }) {
  const { t } = useTranslation()

  if (recording.kind !== 'Traffic') {
    return (
      <EmptyState
        icon={FileX}
        title={t('recordings.traffic.wrongKind')}
      />
    )
  }

  const downloadHref = recordingTcpdumpUrl(recording.id)
  const downloadFilename = `${recording.name}.pcap`

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="truncate">{recording.name}</CardTitle>
          <CardDescription>{t('recordings.traffic.title')}</CardDescription>
        </div>
        <a
          href={downloadHref}
          download={downloadFilename}
          className="focus-ring inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 text-sm font-medium text-primary-foreground no-underline transition duration-150 ease-out hover:brightness-90 active:translate-y-px"
        >
          <Download size={14} aria-hidden="true" />
          <span>{t('recordings.traffic.download')}</span>
        </a>
      </CardHeader>
      <CardContent className="grid gap-3 text-[13px]">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">{t('recordings.traffic.started')}</dt>
          <dd className="m-0 mono">{formatTimestamp(recording.started)}</dd>
          <dt className="text-muted-foreground">{t('recordings.traffic.ended')}</dt>
          <dd className="m-0 mono">{formatTimestamp(recording.ended)}</dd>
        </dl>
        <div>
          <div className="mb-1.5 text-muted-foreground">{t('recordings.traffic.metadata')}</div>
          <pre className="mono m-0 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted px-3 py-2 text-[12px]">{recording.metadata}</pre>
        </div>
      </CardContent>
    </Card>
  )
}
