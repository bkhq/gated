import type { AuthRequest, AuthRequestState } from '@/shared/types/domain'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Clock, Database, RefreshCw, Search, Terminal, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  useAuthRequests,
  useAuthRequestsPending,
  useDecideAuthRequest,
} from '@/features/auth-requests/hooks/use-auth-requests-queries'
import { useAuthRequestsStream } from '@/features/auth-requests/hooks/use-auth-requests-stream'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/shared/ui/card'
import { Checkbox } from '@/shared/ui/checkbox'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { useAppStore } from '@/store/app-store'

type TabKey = 'pending' | 'history'
type DateRangeKey = 'today' | '7d' | '30d' | 'all'

const ALL_STATUSES: AuthRequestState[] = ['pending', 'approved', 'rejected', 'expired']
const HISTORY_PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 200

// External 1Hz ticker so the countdown can re-render without setState-in-effect.
const tickListeners = new Set<() => void>()
let tickIntervalId: ReturnType<typeof setInterval> | null = null
function notifyTickListeners() {
  for (const fn of tickListeners)
    fn()
}
function subscribeNow(listener: () => void): () => void {
  tickListeners.add(listener)
  if (tickIntervalId === null) {
    tickIntervalId = setInterval(notifyTickListeners, 1000)
  }
  return () => {
    tickListeners.delete(listener)
    if (tickListeners.size === 0 && tickIntervalId !== null) {
      clearInterval(tickIntervalId)
      tickIntervalId = null
    }
  }
}
function useNowSecond(): number {
  return React.useSyncExternalStore(
    subscribeNow,
    () => Math.floor(Date.now() / 1000) * 1000,
    () => 0,
  )
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const id = setTimeout(setDebounced, delayMs, value)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

function formatCountdown(msLeft: number): { mm: string, ss: string } {
  const total = Math.max(0, Math.floor(msLeft / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return { mm, ss }
}

function formatAbsolute(iso: string | undefined): string {
  if (!iso)
    return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()))
    return '—'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function withinDateRange(iso: string, range: DateRangeKey, now: number): boolean {
  if (range === 'all')
    return true
  const t = new Date(iso).getTime()
  if (Number.isNaN(t))
    return false
  if (range === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return t >= start.getTime()
  }
  const days = range === '7d' ? 7 : 30
  return t >= now - days * 24 * 60 * 60 * 1000
}

export function AuthRequestsContent() {
  const { t } = useTranslation()
  const identity = useAppStore(s => s.identity)
  const allQuery = useAuthRequests()
  const pendingQuery = useAuthRequestsPending()
  const decide = useDecideAuthRequest()

  // Live stream — invalidates ['auth-requests'] on every backend frame.
  // Backend handles request expiry; the previous 30s client tick is gone.
  useAuthRequestsStream()

  const all = React.useMemo(() => allQuery.data ?? [], [allQuery.data])
  const pendingLive = React.useMemo(() => pendingQuery.data ?? [], [pendingQuery.data])

  const [tab, setTab] = React.useState<TabKey>('pending')
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={tab} onChange={next => setTab(next as TabKey)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="pending">
              <span className="inline-flex items-center gap-1.5">
                {pendingLive.length > 0
                  ? <span aria-hidden="true" className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--info))]" />
                  : null}
                <span>{t('authRequests.tabs.pending')}</span>
                <span className="tabular text-muted-foreground">
                  ·
                  {' '}
                  {pendingLive.length}
                </span>
              </span>
            </TabsTrigger>
            <TabsTrigger value="history">
              <span className="inline-flex items-center gap-1.5">
                <span>{t('authRequests.tabs.history')}</span>
                <span className="tabular text-muted-foreground">
                  ·
                  {' '}
                  {all.length}
                </span>
              </span>
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { void allQuery.refetch() }}>
              <RefreshCw size={14} />
              <span>{t('actions.refresh')}</span>
            </Button>
            <Badge tone="info">
              <span aria-hidden="true" className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--info))]" />
              <span className="ml-1">SSE · live</span>
            </Badge>
          </div>
        </div>

        <TabsContent value="pending">
          <PendingView
            requests={pendingLive}
            loading={pendingQuery.isLoading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            decideLoading={decide.isPending}
            onDecide={(id, decision) => decide.mutate({ id, decision, decidedBy: identity.username })}
          />
        </TabsContent>
        <TabsContent value="history">
          <HistoryView requests={all} loading={allQuery.isLoading} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function AuthRequestsPage() {
  const { t } = useTranslation()

  return (
    <div className="page-enter">
      <PageHeader
        title={t('menu.authRequests')}
      />
      <div className="px-6 pb-6 pt-4">
        <AuthRequestsContent />
      </div>
    </div>
  )
}

// ── Pending view ────────────────────────────────────────────────────────────

function PendingView({
  requests,
  loading,
  selectedId,
  onSelect,
  decideLoading,
  onDecide,
}: {
  requests: AuthRequest[]
  loading: boolean
  selectedId: string | null
  onSelect: (id: string | null) => void
  decideLoading: boolean
  onDecide: (id: string, decision: 'approved' | 'rejected') => void
}) {
  const { t } = useTranslation()

  // Resolve the selected item against the live pending list (auto-falls back to head).
  // selectedId is kept as the user's last explicit pick — even if its item is gone, the UI
  // surfaces the first pending item so the panel is never empty.
  const current = React.useMemo<AuthRequest | null>(() => {
    if (selectedId) {
      const hit = requests.find(item => item.id === selectedId)
      if (hit)
        return hit
    }
    return requests[0] ?? null
  }, [requests, selectedId])

  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <section aria-label={t('a11y.authRequests.pendingInbox')} className="flex flex-col gap-2">
        <div className="px-1 text-[12px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
          {requests.length}
          {' '}
          {t('status.pending').toLowerCase()}
        </div>
        <div className="flex flex-col gap-1.5">
          {requests.length === 0
            ? <EmptyState icon={undefined} title={t('authRequests.empty.pending')} />
            : requests.map((request) => {
                const isSelected = request.id === current?.id
                return (
                  <button
                    key={request.id}
                    type="button"
                    onClick={() => onSelect(request.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={t('a11y.authRequests.pendingRequestRow', { target: request.target })}
                    className={cn(
                      'focus-ring rounded-md border p-3 text-left transition',
                      isSelected
                        ? 'border-ring bg-accent shadow-[0_0_0_3px_hsl(var(--ring)/0.18)]'
                        : 'border-border bg-card hover:bg-accent/40',
                    )}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <div aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary">
                        {request.protocol === 'ssh' ? <Terminal size={14} /> : <Database size={14} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold">{request.target}</div>
                        <div className="text-[12px] text-muted-foreground">
                          {request.protocol.toUpperCase()}
                          {' · '}
                          {request.at}
                        </div>
                      </div>
                      <StateBadge state={request.state} />
                    </div>
                    <div className="mono text-[12px] text-muted-foreground">{request.clientHint}</div>
                  </button>
                )
              })}
        </div>
      </section>

      {current
        ? (
            <PendingDetail
              request={current}
              decideLoading={decideLoading}
              onDecide={onDecide}
            />
          )
        : (
            <EmptyState
              icon={undefined}
              title={t('authRequests.empty.pending')}
              description={t('authRequests.empty.pendingHint')}
            />
          )}
    </div>
  )
}

function PendingDetail({
  request,
  decideLoading,
  onDecide,
}: {
  request: AuthRequest
  decideLoading: boolean
  onDecide: (id: string, decision: 'approved' | 'rejected') => void
}) {
  const { t } = useTranslation()
  const now = useNowSecond()
  const expiresMs = new Date(request.expiresAt).getTime()
  const msLeft = expiresMs - now
  const isExpired = msLeft <= 0
  const isUrgent = !isExpired && msLeft <= 60_000
  const { mm, ss } = formatCountdown(msLeft)

  return (
    <Card>
      <CardHeader className="border-b border-border px-6 pb-4 pt-5">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="info">{request.protocol.toUpperCase()}</Badge>
            <StateBadge state={isExpired ? 'expired' : request.state} />
          </div>
          <h3 className="m-0 text-[18px] font-semibold">
            {t('authRequests.detail.title')}
            {' → '}
            <span className="mono">{request.target}</span>
          </h3>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {t('authRequests.detail.subtitle')}
          </p>
        </div>
      </CardHeader>

      <CardContent className="px-6 pt-5">
        <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3.5 text-[13.5px]">
          <Row label={t('authRequests.detail.fields.target')}>
            <span className="mono">{request.target}</span>
          </Row>
          <Row label={t('authRequests.detail.fields.protocol')}>{request.protocol.toUpperCase()}</Row>
          <Row label={t('authRequests.detail.fields.actor')}>
            <span className="mono">{request.actor ?? '—'}</span>
          </Row>
          <Row label={t('authRequests.detail.fields.fromIp')}>
            <span className="mono">{request.clientIp ?? request.from}</span>
          </Row>
          <Row label={t('authRequests.detail.fields.location')}>
            {request.clientLocation ?? '—'}
          </Row>
          <Row label={t('authRequests.detail.fields.client')}>
            <span className="mono">{request.clientHint}</span>
          </Row>
          <Row label={t('authRequests.detail.fields.initiated')}>{formatAbsolute(request.createdAt)}</Row>
          <Row label={t('authRequests.detail.fields.expiresAt')}>{formatAbsolute(request.expiresAt)}</Row>
          <Row label={t('authRequests.detail.fields.requestId')}>
            <span className="mono">{request.id}</span>
          </Row>
        </div>

        <div className="mt-5 flex gap-2.5 rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3.5 text-[13px]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[hsl(var(--warning))]" />
          <div>
            <div className="font-medium text-foreground">{t('authRequests.detail.warningTitle')}</div>
            <div className="mt-0.5 text-muted-foreground">
              {t('authRequests.detail.warningBody')}
            </div>
          </div>
        </div>
      </CardContent>

      <CardFooter className="px-6 py-3.5">
        <div
          aria-label={t('a11y.authRequests.countdownLive')}
          className="text-[12px] text-muted-foreground"
        >
          {isExpired
            ? (
                <span className="inline-flex items-center gap-1 text-[hsl(var(--destructive))]">
                  <Clock size={12} aria-hidden="true" />
                  {t('authRequests.countdown.expired')}
                </span>
              )
            : (
                <span className={cn('inline-flex items-center gap-1', isUrgent && 'text-[hsl(var(--destructive))]')}>
                  {t('authRequests.countdown.expiresIn')}
                  {' '}
                  <span className="tabular">
                    {mm}
                    :
                    {ss}
                  </span>
                </span>
              )}
        </div>
        {/* Off-screen live region that only fires on the expired transition;
            announcing every second would spam AT users. */}
        <div role="status" aria-live="polite" className="sr-only">
          {isExpired ? t('authRequests.countdown.expired') : ''}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={decideLoading || isExpired} onClick={() => onDecide(request.id, 'rejected')}>
            <X size={14} />
            <span>{t('actions.reject')}</span>
          </Button>
          <Button disabled={decideLoading || isExpired} onClick={() => onDecide(request.id, 'approved')}>
            <Check size={14} />
            <span>{t('actions.approve')}</span>
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}

// ── History view ────────────────────────────────────────────────────────────

function HistoryView({
  requests,
  loading,
}: {
  requests: AuthRequest[]
  loading: boolean
}) {
  const { t } = useTranslation()
  const [statusFilter, setStatusFilter] = React.useState<Set<AuthRequestState>>(() => new Set(ALL_STATUSES))
  const [dateRange, setDateRange] = React.useState<DateRangeKey>('all')
  const [search, setSearch] = React.useState('')
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS)
  const [page, setPage] = React.useState(1)
  const [sortDesc, setSortDesc] = React.useState(true)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  const [nowMs] = React.useState<number>(() => Date.now())
  const filtered = React.useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    const list = requests.filter((item) => {
      if (!statusFilter.has(item.state))
        return false
      if (!withinDateRange(item.createdAt, dateRange, nowMs))
        return false
      if (q) {
        const hay = `${item.target} ${item.actor ?? ''} ${item.clientHint}`.toLowerCase()
        if (!hay.includes(q))
          return false
      }
      return true
    })
    list.sort((a, b) => {
      const ta = new Date(a.createdAt).getTime()
      const tb = new Date(b.createdAt).getTime()
      return sortDesc ? tb - ta : ta - tb
    })
    return list
  }, [requests, statusFilter, dateRange, debouncedSearch, sortDesc, nowMs])

  const total = filtered.length
  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE))
  const clampedPage = Math.min(page, pageCount)
  const start = total === 0 ? 0 : (clampedPage - 1) * HISTORY_PAGE_SIZE
  const end = Math.min(total, start + HISTORY_PAGE_SIZE)
  const rows = filtered.slice(start, end)

  const allChecked = statusFilter.size === ALL_STATUSES.length
  const toggleStatus = (s: AuthRequestState) => {
    setPage(1)
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(s))
        next.delete(s)
      else
        next.add(s)
      return next
    })
  }
  const handleDateRange = (v: DateRangeKey) => {
    setPage(1)
    setDateRange(v)
  }
  const handleSearch = (v: string) => {
    setPage(1)
    setSearch(v)
  }
  const handleSortToggle = () => {
    setPage(1)
    setSortDesc(prev => !prev)
  }
  const clearFilters = () => {
    setPage(1)
    setStatusFilter(new Set(ALL_STATUSES))
    setDateRange('all')
    setSearch('')
  }

  return (
    <Card>
      <CardHeader className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[220px] flex-1">
            <Input
              icon={Search}
              value={search}
              onChange={e => handleSearch(e.target.value)}
              placeholder={t('authRequests.filters.search')}
              aria-label={t('authRequests.filters.search')}
            />
          </div>
          <div
            role="group"
            aria-label={t('a11y.authRequests.statusFilterGroup')}
            className="flex flex-wrap items-center gap-2"
          >
            <span aria-hidden="true" className="text-[12px] text-muted-foreground">{t('authRequests.filters.allStatus')}</span>
            {ALL_STATUSES.map(s => (
              <Checkbox
                key={s}
                checked={statusFilter.has(s)}
                onCheckedChange={() => toggleStatus(s)}
                label={<span className="text-[13px]">{t(`authRequests.status.${s}`)}</span>}
                className="select-none"
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">{t('authRequests.filters.dateRange')}</span>
            <Select
              value={dateRange}
              onValueChange={v => handleDateRange(v as DateRangeKey)}
              options={[
                { value: 'today', label: t('authRequests.filters.range.today') },
                { value: '7d', label: t('authRequests.filters.range.7d') },
                { value: '30d', label: t('authRequests.filters.range.30d') },
                { value: 'all', label: t('authRequests.filters.range.all') },
              ]}
              className="h-8 w-[140px]"
              aria-label={t('authRequests.filters.dateRange')}
            />
          </div>
          {!allChecked || dateRange !== 'all' || debouncedSearch
            ? (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  {t('actions.clearFilters')}
                </Button>
              )
            : null}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {loading
          ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            )
          : total === 0
            ? (
                <div className="p-10">
                  <EmptyState
                    icon={undefined}
                    title={t('authRequests.empty.history')}
                    description={t('authRequests.empty.historyHint')}
                    action={(
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        {t('actions.clearFilters')}
                      </Button>
                    )}
                  />
                </div>
              )
            : (
                <Table className="rounded-none border-0">
                  <THead>
                    <TR>
                      <TH className="w-[180px]" aria-sort={sortDesc ? 'descending' : 'ascending'}>
                        <button
                          type="button"
                          className="focus-ring -mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
                          onClick={handleSortToggle}
                          aria-label={`${t('authRequests.columns.createdAt')} — ${t(sortDesc ? 'a11y.authRequests.sortDescending' : 'a11y.authRequests.sortAscending')}`}
                        >
                          <span>{t('authRequests.columns.createdAt')}</span>
                          {sortDesc ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
                        </button>
                      </TH>
                      <TH className="w-[140px]">{t('authRequests.columns.actor')}</TH>
                      <TH>{t('authRequests.columns.target')}</TH>
                      <TH className="w-[90px]">{t('authRequests.columns.protocol')}</TH>
                      <TH>{t('authRequests.columns.client')}</TH>
                      <TH className="w-[120px]">{t('authRequests.columns.status')}</TH>
                      <TH className="w-[160px]">{t('authRequests.columns.decidedAt')}</TH>
                      <TH className="w-[140px]">{t('authRequests.columns.decidedBy')}</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((item) => {
                      const isExpanded = expandedId === item.id
                      const detailRowId = `auth-request-detail-${item.id}`
                      const toggleExpand = () => setExpandedId(prev => prev === item.id ? null : item.id)
                      const onRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          toggleExpand()
                        }
                      }
                      return (
                        <React.Fragment key={item.id}>
                          <TR
                            role="button"
                            tabIndex={0}
                            aria-expanded={isExpanded}
                            aria-controls={isExpanded ? detailRowId : undefined}
                            aria-label={t(isExpanded ? 'a11y.authRequests.collapseRow' : 'a11y.authRequests.expandRow')}
                            onClick={toggleExpand}
                            onKeyDown={onRowKeyDown}
                          >
                            <TD>
                              <div className="text-[13px]">{formatAbsolute(item.createdAt)}</div>
                              <div className="text-[11.5px] text-muted-foreground">{item.at}</div>
                            </TD>
                            <TD>
                              <span className="mono text-[13px]">{item.actor ?? '—'}</span>
                            </TD>
                            <TD>
                              <span className="mono text-[13px]">{item.target}</span>
                            </TD>
                            <TD>
                              <Badge tone="outline">{item.protocol.toUpperCase()}</Badge>
                            </TD>
                            <TD>
                              <div className="mono text-[12.5px]">{item.clientHint}</div>
                              <div className="text-[11.5px] text-muted-foreground">
                                {item.clientIp ?? item.from}
                              </div>
                            </TD>
                            <TD><StateBadge state={item.state} /></TD>
                            <TD>
                              <span className="text-[13px]">{formatAbsolute(item.decidedAt)}</span>
                            </TD>
                            <TD>
                              <span className="mono text-[13px]">{item.decidedBy ?? '—'}</span>
                            </TD>
                          </TR>
                          {isExpanded
                            ? (
                                <TR id={detailRowId}>
                                  <TD className="bg-[hsl(var(--muted)/0.3)]" colSpan={8}>
                                    <div
                                      role="region"
                                      aria-label={t('a11y.authRequests.rowDetailsRegion', { target: item.target })}
                                      className="grid grid-cols-1 gap-x-6 gap-y-2 px-2 py-1 text-[12.5px] md:grid-cols-2 lg:grid-cols-3"
                                    >
                                      <DetailItem label={t('authRequests.detail.fields.location')} value={item.clientLocation ?? '—'} />
                                      <DetailItem label={t('authRequests.detail.fields.expiresAt')} value={formatAbsolute(item.expiresAt)} />
                                      <DetailItem
                                        label={t('authRequests.detail.relatedSession')}
                                        value={item.relatedSessionId ? <span className="mono">{item.relatedSessionId}</span> : '—'}
                                      />
                                      <DetailItem
                                        label={t('authRequests.detail.fields.requestId')}
                                        value={<span className="mono">{item.id}</span>}
                                      />
                                    </div>
                                  </TD>
                                </TR>
                              )
                            : null}
                        </React.Fragment>
                      )
                    })}
                  </TBody>
                </Table>
              )}
      </CardContent>

      {total > 0
        ? (
            <CardFooter className="justify-end gap-3 px-4 py-2.5 text-[12.5px] text-muted-foreground">
              <span className="tabular">
                {t('authRequests.pagination.range', {
                  start: start + 1,
                  end,
                  total,
                })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clampedPage <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  {t('authRequests.pagination.prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clampedPage >= pageCount}
                  onClick={() => setPage(p => Math.min(pageCount, p + 1))}
                >
                  {t('authRequests.pagination.next')}
                </Button>
              </div>
            </CardFooter>
          )
        : null}
    </Card>
  )
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function Row({ label, children }: { label: React.ReactNode, children: React.ReactNode }) {
  return (
    <>
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div>{children}</div>
    </>
  )
}

function DetailItem({ label, value }: { label: React.ReactNode, value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  )
}

function StateBadge({ state }: { state: AuthRequestState }) {
  const { t } = useTranslation()
  if (state === 'pending') {
    return (
      <Badge tone="info">
        <span aria-hidden="true" className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--info))]" />
        <span className="ml-1">{t('authRequests.status.pending')}</span>
      </Badge>
    )
  }
  if (state === 'approved') {
    return (
      <Badge tone="success">
        <Check size={11} />
        <span>{t('authRequests.status.approved')}</span>
      </Badge>
    )
  }
  if (state === 'rejected') {
    return (
      <Badge tone="danger">
        <X size={11} />
        <span>{t('authRequests.status.rejected')}</span>
      </Badge>
    )
  }
  return (
    <Badge tone="mono">
      <Clock size={11} />
      <span>{t('authRequests.status.expired')}</span>
    </Badge>
  )
}
