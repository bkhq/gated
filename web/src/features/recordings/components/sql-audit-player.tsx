import type { Recording } from '@/shared/lib/api/recordings'
import { Link } from '@tanstack/react-router'
import { Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/shared/components/empty-state'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'

function formatTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined || value.length === 0)
    return fallback
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
    return value
  return parsed.toLocaleString()
}

export function SqlAuditPlayer({ recording }: { recording: Recording }) {
  const { t } = useTranslation()
  const dash = '—'

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{recording.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-foreground">{t('recordings.sqlAudit.started')}</dt>
            <dd className="text-muted-foreground">{formatTimestamp(recording.started, dash)}</dd>
            <dt className="font-medium text-foreground">{t('recordings.sqlAudit.ended')}</dt>
            <dd className="text-muted-foreground">{formatTimestamp(recording.ended, dash)}</dd>
            <dt className="font-medium text-foreground">{t('recordings.sqlAudit.metadata')}</dt>
            <dd className="whitespace-pre-wrap break-words font-mono text-[12px] text-muted-foreground">
              {recording.metadata.length > 0 ? recording.metadata : dash}
            </dd>
          </dl>
        </CardContent>
      </Card>
      <EmptyState
        icon={Database}
        title={t('recordings.sqlAudit.title')}
        description={t('recordings.sqlAudit.notWired')}
        action={(
          <Link
            to="/admin/audit"
            className="text-[13px] font-medium text-foreground underline underline-offset-4 hover:text-primary"
          >
            {t('recordings.sqlAudit.openAudit')}
          </Link>
        )}
      />
    </div>
  )
}
