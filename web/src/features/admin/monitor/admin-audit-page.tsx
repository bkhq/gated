import { ChevronDown, ChevronRight, Download, Search, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAudit } from '@/features/audit/hooks/use-audit-queries'

import { CopyableId } from '@/shared/components/copyable-id'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { TimeText } from '@/shared/components/time-text'
import { eventLabel } from '@/shared/lib/event-label'
import { Avatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const AUDIT_RANGES = ['24h', '7d', '30d'] as const
type AuditRange = (typeof AUDIT_RANGES)[number]
const AUDIT_RANGE_DAYS: Record<AuditRange, number> = { '24h': 1, '7d': 7, '30d': 30 }

function formatClockTime(d: Date) {
  return d.toTimeString().slice(0, 8)
}

function formatIsoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function AdminAuditPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const [plane, setPlane] = React.useState<'session' | 'management'>('session')
  const auditQuery = useAudit({ plane })
  const [query, setQuery] = React.useState('')
  const [range, setRange] = React.useState<AuditRange>('24h')
  const [lastUpdated, setLastUpdated] = React.useState(() => formatClockTime(new Date()))
  const todayLabel = React.useMemo(() => formatIsoDate(new Date()), [])
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())

  const toggleExpanded = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) {
        next.add(id)
      }
      return next
    })
  }, [])

  // Per spec: switching the time range refreshes the "last updated" clock.
  const handleRangeChange = React.useCallback((next: AuditRange) => {
    setRange(next)
    setLastUpdated(formatClockTime(new Date()))
  }, [])

  const resetFilters = React.useCallback(() => {
    setQuery('')
    setRange('30d')
    setLastUpdated(formatClockTime(new Date()))
  }, [])

  const filtered = React.useMemo(() => {
    const data = auditQuery.data ?? []
    const maxDays = AUDIT_RANGE_DAYS[range]
    const needle = query.trim().toLowerCase()
    return data.filter((entry) => {
      if (entry.ageDays >= maxDays) {
        return false
      }
      if (!needle) {
        return true
      }
      const haystack = `${entry.actor} ${entry.action} ${entry.sessionId}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [auditQuery.data, query, range])

  const handleExport = React.useCallback(() => {
    if (filtered.length === 0) {
      return
    }
    const lines = filtered.map(entry => JSON.stringify({
      id: entry.id,
      at: entry.at,
      actor: entry.actor,
      action: entry.action,
      sessionId: entry.sessionId,
    }))
    const blob = new Blob([`${lines.join('\n')}\n`], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `audit-${todayLabel}.jsonl`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }, [filtered, todayLabel])

  const isLoading = auditQuery.isPending
  const exportButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={handleExport}
      disabled={filtered.length === 0}
    >
      <Download size={13} />
      <span>{t('audit.actions.exportJsonl')}</span>
    </Button>
  )

  return (
    <>
      {embedded
        ? null
        : (
            <PageHeader
              title={t('nav.adminAudit')}
              description={t('audit.description')}
              breadcrumbs={[
                { label: t('section.admin') },
                { label: t('nav.adminAudit') },
              ]}
              actions={exportButton}
            />
          )}

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <Select aria-label={t('audit.plane')} value={plane} onValueChange={value => setPlane(value as 'session' | 'management')} options={[{ value: 'session', label: t('audit.sessionPlane') }, { value: 'management', label: t('audit.managementPlane') }]} />
        <div className="w-[420px] max-w-full">
          <Input
            icon={Search}
            className="mono"
            placeholder="actor:* action:session.*"
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('audit.searchAria')}
          />
        </div>
        <Select
          className="w-[140px]"
          value={range}
          onValueChange={value => handleRangeChange(value as AuditRange)}
          aria-label={t('audit.rangeAria')}
          options={AUDIT_RANGES.map(value => ({ value, label: t(`audit.ranges.${value}`) }))}
        />
        <span className="flex-1" />
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex items-center gap-3"
        >
          <span className="mono tabular text-[12px] text-muted-foreground">
            {t('audit.status.lastUpdated', { at: lastUpdated })}
          </span>
          <span className="tabular text-[12px] text-muted-foreground">
            {t('audit.status.rowsOf', {
              shown: filtered.length.toLocaleString(),
              date: todayLabel,
            })}
          </span>
        </span>
        {embedded ? exportButton : null}
      </div>

      <div className="px-6 pb-6 pt-2">
        <Table>
          <THead>
            <TR>
              <TH className="w-[110px] pl-5">{t('audit.fields.time')}</TH>
              <TH>{t('audit.fields.actor')}</TH>
              <TH className="pr-5">{t('audit.fields.action')}</TH>
            </TR>
          </THead>
          <TBody>
            {isLoading
              ? Array.from({ length: 6 }, (_, index) => (
                  <TR key={`skeleton-${index}`}>
                    <TD className="pl-5"><Skeleton className="h-3.5 w-16" /></TD>
                    <TD><Skeleton className="h-4 w-28" /></TD>
                    <TD className="pr-5"><Skeleton className="h-3.5 w-64" /></TD>
                  </TR>
                ))
              : filtered.length === 0
                ? (
                    <TR>
                      <TD colSpan={3} className="px-0 py-0">
                        <div className="p-6">
                          <EmptyState
                            icon={Search}
                            title={t('audit.empty.title')}
                            description={t('audit.empty.description')}
                            action={query
                              ? (
                                  <Button variant="outline" size="sm" onClick={resetFilters}>
                                    <X size={13} />
                                    <span>{t('actions.clearFilters')}</span>
                                  </Button>
                                )
                              : undefined}
                          />
                        </div>
                      </TD>
                    </TR>
                  )
                : filtered.map((entry) => {
                    const detailPairs = Object.entries(entry.values)
                    const isExpanded = expanded.has(entry.id)
                    return (
                      <React.Fragment key={entry.id}>
                        <TR className={isExpanded ? 'border-b-0' : undefined}>
                          <TD className="mono tabular pl-5 text-[12.5px] text-muted-foreground"><TimeText iso={entry.at} /></TD>
                          <TD>
                            <div className="flex items-center gap-2">
                              <Avatar name={entry.actor} size={20} />
                              <span className="truncate">{entry.actor}</span>
                            </div>
                          </TD>
                          <TD className="pr-5">
                            <div className="flex items-center gap-1">
                              <span className="text-[13px]" title={entry.action}>{eventLabel(t, entry.action)}</span>
                              <span aria-hidden="true" className="mx-1 text-muted-foreground">·</span>
                              <CopyableId id={entry.sessionId} className="text-muted-foreground" />
                              {detailPairs.length > 0
                                ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      className="ml-auto h-6 w-6 text-muted-foreground"
                                      aria-expanded={isExpanded}
                                      aria-label={t(isExpanded ? 'audit.details.collapse' : 'audit.details.expand')}
                                      title={t(isExpanded ? 'audit.details.collapse' : 'audit.details.expand')}
                                      onClick={() => toggleExpanded(entry.id)}
                                    >
                                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    </Button>
                                  )
                                : null}
                            </div>
                          </TD>
                        </TR>
                        {isExpanded
                          ? (
                              <TR>
                                <TD colSpan={3} className="pb-3 pl-5 pr-5 pt-0">
                                  <dl className="mono grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
                                    {detailPairs.map(([key, value]) => (
                                      <React.Fragment key={key}>
                                        <dt className="text-muted-foreground">{key}</dt>
                                        <dd className="break-all">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                                      </React.Fragment>
                                    ))}
                                  </dl>
                                </TD>
                              </TR>
                            )
                          : null}
                      </React.Fragment>
                    )
                  })}
          </TBody>
        </Table>
        {auditQuery.hasNextPage
          ? (
              <div className="flex justify-center pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={auditQuery.isFetchingNextPage}
                  onClick={() => { void auditQuery.fetchNextPage() }}
                >
                  {t('pagination.loadMore')}
                </Button>
              </div>
            )
          : null}
      </div>
    </>
  )
}
