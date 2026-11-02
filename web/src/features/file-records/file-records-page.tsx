import type { FileRecord, FileRecordOrigin, FileRecordsQuery } from '@/shared/lib/api/file-records'
import { ChevronLeft, ChevronRight, FolderSync, Search } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useFileRecords } from '@/features/file-records/hooks/use-file-records-queries'
import { formatSize } from '@/features/files/lib/paths'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { TimeText } from '@/shared/components/time-text'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const PAGE_SIZE = 50
const RANGES = ['any', '24h', '7d', '30d'] as const
type Range = (typeof RANGES)[number]
const RANGE_MS: Record<Exclude<Range, 'any'>, number> = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
}
const OPERATIONS = ['read', 'write', 'remove', 'rename', 'mkdir', 'rmdir', 'symlink', 'setstat'] as const

interface Filters {
  q: string
  username: string
  sessionId: string
  origin: 'all' | FileRecordOrigin
  operation: 'all' | (typeof OPERATIONS)[number]
  range: Range
}

const EMPTY_FILTERS: Filters = {
  q: '',
  username: '',
  sessionId: '',
  origin: 'all',
  operation: 'all',
  range: 'any',
}

export function FileRecordsPage({ embedded = false, sessionId }: { embedded?: boolean, sessionId?: string }) {
  const { t } = useTranslation()
  // A fixed session scope survives "clear filters" and hides the session input.
  const baseFilters = React.useMemo<Filters>(() => ({ ...EMPTY_FILTERS, sessionId: sessionId ?? '' }), [sessionId])
  const [filters, setFilters] = React.useState<Filters>(baseFilters)
  const [offset, setOffset] = React.useState(0)

  const query = React.useMemo<FileRecordsQuery>(() => {
    const q: FileRecordsQuery = { limit: PAGE_SIZE, offset }
    if (filters.q.trim())
      q.q = filters.q.trim()
    if (filters.username.trim())
      q.username = filters.username.trim()
    if (filters.sessionId.trim())
      q.session_id = filters.sessionId.trim()
    if (filters.origin !== 'all')
      q.origin = filters.origin
    if (filters.operation !== 'all')
      q.operation = filters.operation
    if (filters.range !== 'any')
      q.from = new Date(Date.now() - RANGE_MS[filters.range]).toISOString()
    return q
  }, [filters, offset])

  const recordsQuery = useFileRecords(query)
  const items = recordsQuery.data?.items ?? []
  const total = recordsQuery.data?.total ?? 0

  function patch<K extends keyof Filters>(key: K, value: Filters[K]) {
    setOffset(0)
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  const hasActiveFilters = JSON.stringify(filters) !== JSON.stringify(baseFilters)
  const pageStart = total === 0 ? 0 : offset + 1
  const pageEnd = Math.min(offset + PAGE_SIZE, total)

  return (
    <>
      {embedded
        ? null
        : (
            <PageHeader
              title={t('nav.adminFileRecords')}
              description={t('fileRecords.description')}
              breadcrumbs={[{ label: t('section.admin') }, { label: t('nav.adminFileRecords') }]}
            />
          )}

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[280px]">
          <Input
            icon={Search}
            placeholder={t('fileRecords.searchPlaceholder')}
            value={filters.q}
            onChange={event => patch('q', event.target.value)}
            aria-label={t('fileRecords.searchPlaceholder')}
          />
        </div>
        <Input
          wrapperClassName="w-[160px]"
          placeholder={t('fields.user')}
          value={filters.username}
          onChange={event => patch('username', event.target.value)}
          aria-label={t('fields.user')}
        />
        {sessionId === undefined
          ? (
              <Input
                wrapperClassName="w-[200px]"
                className="mono"
                placeholder={t('fileRecords.fields.sessionId')}
                value={filters.sessionId}
                onChange={event => patch('sessionId', event.target.value)}
                aria-label={t('fileRecords.fields.sessionId')}
              />
            )
          : null}
        <Select
          className="w-[130px]"
          aria-label={t('fileRecords.fields.origin')}
          value={filters.origin}
          onValueChange={value => patch('origin', value as Filters['origin'])}
          options={[
            { value: 'all', label: t('fileRecords.filter.allOrigins') },
            { value: 'sftp', label: t('fileRecords.origin.sftp') },
            { value: 'web', label: t('fileRecords.origin.web') },
          ]}
        />
        <Select
          className="w-[140px]"
          aria-label={t('fileRecords.fields.operation')}
          value={filters.operation}
          onValueChange={value => patch('operation', value as Filters['operation'])}
          options={[
            { value: 'all', label: t('fileRecords.filter.allOperations') },
            ...OPERATIONS.map(value => ({ value, label: t(`fileRecords.operation.${value}`) })),
          ]}
        />
        <Select
          className="w-[130px]"
          aria-label={t('fileRecords.fields.range')}
          value={filters.range}
          onValueChange={value => patch('range', value as Range)}
          options={RANGES.map(value => ({ value, label: t(`commandRecords.ranges.${value}`) }))}
        />
        {hasActiveFilters
          ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilters(baseFilters)
                  setOffset(0)
                }}
              >
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span className="tabular text-[12px] text-muted-foreground">
          {t('commandRecords.pagination.range', { from: pageStart, to: pageEnd, total })}
        </span>
      </div>

      <div className="px-6 pb-6 pt-2">
        <Table>
          <THead>
            <TR>
              <TH className="w-[130px] pl-5">{t('fileRecords.fields.timestamp')}</TH>
              <TH className="w-[70px]">{t('fileRecords.fields.origin')}</TH>
              <TH className="w-[90px]">{t('fileRecords.fields.operation')}</TH>
              <TH>{t('fileRecords.fields.path')}</TH>
              <TH className="w-[90px] text-right">{t('fileRecords.fields.bytes')}</TH>
              <TH>{t('fields.user')}</TH>
              <TH>{t('fields.target')}</TH>
              <TH className="pr-5">{t('fileRecords.fields.result')}</TH>
            </TR>
          </THead>
          <TBody>
            {recordsQuery.isLoading
              ? Array.from({ length: 8 }, (_, index) => (
                  <TR key={`file-rec-skeleton-${String(index)}`}>
                    <TD className="pl-5"><Skeleton className="h-3.5 w-24" /></TD>
                    <TD><Skeleton className="h-5 w-12" /></TD>
                    <TD><Skeleton className="h-5 w-14" /></TD>
                    <TD><Skeleton className="h-3.5 w-64" /></TD>
                    <TD><Skeleton className="ml-auto h-3.5 w-12" /></TD>
                    <TD><Skeleton className="h-3.5 w-20" /></TD>
                    <TD><Skeleton className="h-3.5 w-24" /></TD>
                    <TD className="pr-5"><Skeleton className="h-5 w-12" /></TD>
                  </TR>
                ))
              : items.length === 0
                ? (
                    <TR>
                      <TD colSpan={8} className="px-0 py-0">
                        <div className="p-6">
                          <EmptyState
                            icon={FolderSync}
                            title={t('fileRecords.empty.title')}
                            description={t('fileRecords.empty.description')}
                          />
                        </div>
                      </TD>
                    </TR>
                  )
                : items.map((record, index) => (
                    <RecordRow key={`${record.session_id}-${record.timestamp}-${String(index)}`} record={record} />
                  ))}
          </TBody>
        </Table>

        {total > PAGE_SIZE
          ? (
              <div className="flex items-center justify-end gap-2 pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  <ChevronLeft size={14} />
                  <span>{t('commandRecords.pagination.prev')}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  <span>{t('commandRecords.pagination.next')}</span>
                  <ChevronRight size={14} />
                </Button>
              </div>
            )
          : null}
      </div>
    </>
  )
}

function RecordRow({ record }: { record: FileRecord }) {
  const { t } = useTranslation()
  const path = record.new_path ? `${record.path} → ${record.new_path}` : record.path
  return (
    <TR>
      <TD className="pl-5 text-[12px] text-muted-foreground"><TimeText iso={record.timestamp} /></TD>
      <TD>
        <Badge tone={record.origin === 'web' ? 'info' : 'mono'}>{t(`fileRecords.origin.${record.origin}`)}</Badge>
      </TD>
      <TD className="text-[12.5px]">{t(`fileRecords.operation.${record.operation}`, { defaultValue: record.operation })}</TD>
      <TD className="mono max-w-[420px] truncate text-[12.5px]" title={path}>{path}</TD>
      <TD className="mono tabular text-right text-[12px] text-muted-foreground">{record.bytes == null ? '—' : formatSize(record.bytes)}</TD>
      <TD className="text-[12.5px]">{record.username ?? '—'}</TD>
      <TD className="mono text-[12.5px] text-muted-foreground">{record.target}</TD>
      <TD className="pr-5">
        {record.success
          ? <Badge tone="success">{t('commandRecords.outcome.ok')}</Badge>
          : <Badge tone="danger" title={record.error ?? undefined}>{t('commandRecords.outcome.failed')}</Badge>}
      </TD>
    </TR>
  )
}
