import type { CommandRecord, CommandRecordSource, CommandRecordsQuery } from '@/shared/lib/api/command-records'
import { ChevronLeft, ChevronRight, ScrollText, Search } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCommandRecords } from '@/features/command-records/hooks/use-command-records-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
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

interface Filters {
  q: string
  username: string
  sessionId: string
  targetId: string
  source: 'all' | CommandRecordSource
  range: Range
}

const EMPTY_FILTERS: Filters = {
  q: '',
  username: '',
  sessionId: '',
  targetId: '',
  source: 'all',
  range: 'any',
}

function formatTs(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return value
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function CommandRecordsPage() {
  const { t } = useTranslation()
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS)
  const [offset, setOffset] = React.useState(0)

  // Compute the `from` bound (relative windows are anchored at query build time)
  // whenever the range changes; combined with the debounced text inputs into the
  // final query object below.
  const query = React.useMemo<CommandRecordsQuery>(() => {
    const q: CommandRecordsQuery = { limit: PAGE_SIZE, offset }
    if (filters.q.trim())
      q.q = filters.q.trim()
    if (filters.username.trim())
      q.username = filters.username.trim()
    if (filters.sessionId.trim())
      q.session_id = filters.sessionId.trim()
    if (filters.targetId.trim())
      q.target_id = filters.targetId.trim()
    if (filters.source !== 'all')
      q.source = filters.source
    if (filters.range !== 'any')
      q.from = new Date(Date.now() - RANGE_MS[filters.range]).toISOString()
    return q
  }, [filters, offset])

  const recordsQuery = useCommandRecords(query)
  const data = recordsQuery.data
  const items = data?.items ?? []
  const total = data?.total ?? 0

  function patch<K extends keyof Filters>(key: K, value: Filters[K]) {
    setOffset(0)
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  const hasActiveFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS)
  const pageStart = total === 0 ? 0 : offset + 1
  const pageEnd = Math.min(offset + PAGE_SIZE, total)
  const canPrev = offset > 0
  const canNext = offset + PAGE_SIZE < total
  const isLoading = recordsQuery.isLoading

  return (
    <>
      <PageHeader
        title={t('nav.adminCommandRecords')}
        description={t('commandRecords.description')}
        breadcrumbs={[{ label: t('section.admin') }, { label: t('nav.adminCommandRecords') }]}
      />

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[280px]">
          <Input
            icon={Search}
            placeholder={t('commandRecords.searchPlaceholder')}
            value={filters.q}
            onChange={event => patch('q', event.target.value)}
            aria-label={t('commandRecords.searchPlaceholder')}
          />
        </div>
        <Input
          wrapperClassName="w-[160px]"
          placeholder={t('fields.user')}
          value={filters.username}
          onChange={event => patch('username', event.target.value)}
          aria-label={t('fields.user')}
        />
        <Input
          wrapperClassName="w-[200px]"
          className="mono"
          placeholder={t('commandRecords.fields.sessionId')}
          value={filters.sessionId}
          onChange={event => patch('sessionId', event.target.value)}
          aria-label={t('commandRecords.fields.sessionId')}
        />
        <Select
          className="w-[130px]"
          aria-label={t('commandRecords.fields.source')}
          value={filters.source}
          onValueChange={value => patch('source', value as Filters['source'])}
          options={[
            { value: 'all', label: t('commandRecords.filter.allSources') },
            { value: 'shell', label: t('commandRecords.source.shell') },
            { value: 'sql', label: t('commandRecords.source.sql') },
          ]}
        />
        <Select
          className="w-[130px]"
          aria-label={t('commandRecords.fields.range')}
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
                  setFilters(EMPTY_FILTERS)
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
              <TH className="w-[130px] pl-5">{t('commandRecords.fields.timestamp')}</TH>
              <TH className="w-[70px]">{t('commandRecords.fields.source')}</TH>
              <TH>{t('commandRecords.fields.command')}</TH>
              <TH>{t('fields.user')}</TH>
              <TH>{t('fields.target')}</TH>
              <TH className="pr-5">{t('commandRecords.fields.outcome')}</TH>
            </TR>
          </THead>
          <TBody>
            {isLoading
              ? Array.from({ length: 8 }, (_, index) => (
                  <TR key={`rec-skeleton-${String(index)}`}>
                    <TD className="pl-5"><Skeleton className="h-3.5 w-24" /></TD>
                    <TD><Skeleton className="h-5 w-12" /></TD>
                    <TD><Skeleton className="h-3.5 w-64" /></TD>
                    <TD><Skeleton className="h-3.5 w-20" /></TD>
                    <TD><Skeleton className="h-3.5 w-24" /></TD>
                    <TD className="pr-5"><Skeleton className="h-5 w-16" /></TD>
                  </TR>
                ))
              : items.length === 0
                ? (
                    <TR>
                      <TD colSpan={6} className="px-0 py-0">
                        <div className="p-6">
                          <EmptyState
                            icon={ScrollText}
                            title={t('commandRecords.empty.title')}
                            description={t('commandRecords.empty.description')}
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
                  disabled={!canPrev}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  <ChevronLeft size={14} />
                  <span>{t('commandRecords.pagination.prev')}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canNext}
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

function RecordRow({ record }: { record: CommandRecord }) {
  const { t } = useTranslation()
  return (
    <TR>
      <TD className="mono tabular pl-5 text-[12px] text-muted-foreground">{formatTs(record.timestamp)}</TD>
      <TD>
        <Badge tone={record.source === 'sql' ? 'info' : 'mono'}>
          {t(`commandRecords.source.${record.source}`)}
        </Badge>
      </TD>
      <TD className="mono max-w-[420px] truncate text-[12.5px]" title={record.command}>{record.command}</TD>
      <TD className="text-[12.5px]">{record.username ?? '—'}</TD>
      <TD className="mono text-[12.5px] text-muted-foreground">{record.target ?? '—'}</TD>
      <TD className="pr-5"><OutcomeCell record={record} /></TD>
    </TR>
  )
}

function OutcomeCell({ record }: { record: CommandRecord }) {
  const { t } = useTranslation()
  if (record.source === 'shell') {
    const action = record.acl_action
    const tone = action === 'deny' ? 'danger' : action === 'review' ? 'warning' : 'success'
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {action ? <Badge tone={tone}>{t(`commandAcl.action.${action}`)}</Badge> : null}
        {record.outcome ? <span className="text-[11.5px] text-muted-foreground">{record.outcome}</span> : null}
        {record.acl_rule_name ? <span className="mono text-[11px] text-muted-foreground" title={t('commandRecords.fields.matchedRule')}>{record.acl_rule_name}</span> : null}
      </div>
    )
  }
  // SQL records carry success/error instead of an ACL verdict.
  return record.success === false
    ? <Badge tone="danger" title={record.error ?? undefined}>{t('commandRecords.outcome.failed')}</Badge>
    : <Badge tone="success">{t('commandRecords.outcome.ok')}</Badge>
}
