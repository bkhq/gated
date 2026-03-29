import type { GetLogsRequest } from '@/features/admin/lib/api-client'
import { format } from 'date-fns'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLogsQuery } from '@/features/admin/api'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'

type TimeRange = 'all' | '1h' | '24h' | '7d'

function getAfterTime(range: TimeRange): string | undefined {
  const now = new Date()
  if (range === '1h')
    return new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  if (range === '24h')
    return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  if (range === '7d')
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  return undefined
}

const PAGE_SIZE = 50

export function Component() {
  const { t } = useTranslation('admin')

  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [usernameFilter, setUsernameFilter] = useState('')
  const [searchFilter, setSearchFilter] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)

  const params: GetLogsRequest = useMemo(() => ({
    after: getAfterTime(timeRange),
    username: usernameFilter || undefined,
    search: searchFilter || undefined,
    limit: 500,
  }), [timeRange, usernameFilter, searchFilter])

  const { data: logs = [], isLoading, isFetching, refetch } = useLogsQuery(params, {
    refetchInterval: autoRefresh ? 10_000 : false,
  })

  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE))
  const pagedLogs = logs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id))
        next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleTimeRangeChange(val: string) {
    setTimeRange(val as TimeRange)
    setPage(0)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('log.title')}
        description={t('log.description')}
        actions={(
          <div className="flex items-center gap-2">
            <Button
              variant={autoRefresh ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAutoRefresh(v => !v)}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-spin' : ''}`} />
              {t(autoRefresh ? 'log.autoRefreshOn' : 'log.autoRefreshOff')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        )}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={timeRange} onValueChange={v => v !== null && handleTimeRangeChange(v)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1h">{t('log.last1h')}</SelectItem>
            <SelectItem value="24h">{t('log.last24h')}</SelectItem>
            <SelectItem value="7d">{t('log.last7d')}</SelectItem>
            <SelectItem value="all">{t('log.all')}</SelectItem>
          </SelectContent>
        </Select>

        <Input
          placeholder={t('log.filterByUser')}
          value={usernameFilter}
          onChange={(e) => {
            setUsernameFilter(e.target.value)
            setPage(0)
          }}
          className="w-44"
        />

        <Input
          placeholder={t('log.search')}
          value={searchFilter}
          onChange={(e) => {
            setSearchFilter(e.target.value)
            setPage(0)
          }}
          className="w-56"
        />

        {!isLoading && (
          <span className="text-sm text-muted-foreground ml-auto">
            {t('log.showing', { count: logs.length })}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-44">{t('log.columns.timestamp')}</TableHead>
              <TableHead className="w-32">{t('log.columns.username')}</TableHead>
              <TableHead>{t('log.columns.message')}</TableHead>
              <TableHead className="w-40">{t('log.columns.sessionId')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : pagedLogs.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                        {t('log.noLogs')}
                      </TableCell>
                    </TableRow>
                  )
                : pagedLogs.map((entry) => {
                    const isExpanded = expandedIds.has(entry.id)
                    return (
                      <Fragment key={entry.id}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => toggleExpand(entry.id)}
                        >
                          <TableCell className="text-muted-foreground">
                            {isExpanded
                              ? <ChevronDown className="h-4 w-4" />
                              : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                            {format(new Date(entry.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                          </TableCell>
                          <TableCell>
                            {entry.username != null && entry.username !== ''
                              ? <Badge variant="secondary">{entry.username}</Badge>
                              : <span className="text-muted-foreground text-sm">—</span>}
                          </TableCell>
                          <TableCell className="text-sm">{entry.text}</TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground truncate max-w-40">
                            {entry.session_id != null && entry.session_id !== '' ? entry.session_id : '—'}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell />
                            <TableCell colSpan={4} className="py-3">
                              <pre className="text-xs font-mono bg-background rounded border p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                                {JSON.stringify(entry.values, null, 2)}
                              </pre>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {!isLoading && logs.length > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {page * PAGE_SIZE + 1}
            –
            {Math.min((page + 1) * PAGE_SIZE, logs.length)}
            {' '}
            /
            {logs.length}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
            >
              {t('log.prev')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p + 1)}
              disabled={page >= totalPages - 1}
            >
              {t('log.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
