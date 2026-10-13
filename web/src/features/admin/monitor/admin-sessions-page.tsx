import type { ManagementSession } from '@/shared/lib/api/management-sessions'
import type { LiveSession } from '@/shared/types/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Activity, Download, Eye, FileText, MoreHorizontal, Play, RefreshCw, Search, Trash2, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  useClearSessionHistory,
  useDeleteSessions,
  useForceCloseSessions,
  useLiveSessions,
  useManagementSessions,
  usePastSessions,
  useRevokeManagementSession,
} from '@/features/sessions/hooks/use-sessions-queries'
import { useSessionsStream } from '@/features/sessions/hooks/use-sessions-stream'
import { ConfirmDialog } from '@/features/user/_credential-primitives'
import { BulkActionBar } from '@/shared/components/bulk-action-bar'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { StatCard } from '@/shared/components/stat-card'
import { getSessionRecordings } from '@/shared/lib/api/recordings'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Switch } from '@/shared/ui/switch'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs'

type SessionTab = 'live' | 'past' | 'management'
type ProtocolFilter = 'all' | 'ssh' | 'mysql' | 'pg' | 'http'
type RangeFilter = 'any' | '1h' | '24h' | '7d'

function matchesProtocol(session: LiveSession, filter: ProtocolFilter) {
  if (filter === 'all') {
    return true
  }
  const p = session.protocol.toLowerCase()
  switch (filter) {
    case 'ssh': return p.startsWith('ssh')
    case 'mysql': return p.startsWith('mysql')
    case 'pg': return p.startsWith('pg') || p.startsWith('postgres')
    case 'http': return p.startsWith('http') || p.startsWith('kubernetes')
    default: return true
  }
}

function matchesRange(session: LiveSession, filter: RangeFilter) {
  if (filter === 'any')
    return true
  const started = Date.parse(session.started)
  if (Number.isNaN(started))
    return true
  const windowMs = filter === '1h' ? 3_600_000 : filter === '24h' ? 86_400_000 : 604_800_000
  return Date.now() - started <= windowMs
}

function formatRelative(date: Date | null) {
  if (!date) {
    return null
  }
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 5) {
    return 'just now'
  }
  if (diff < 60) {
    return `${diff}s ago`
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function AdminSessionsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const liveQuery = useLiveSessions()
  const pastQuery = usePastSessions()
  const forceClose = useForceCloseSessions()
  const deleteSessions = useDeleteSessions()
  const clearHistory = useClearSessionHistory()
  useSessionsStream()

  const live = liveQuery.data ?? []
  const past = pastQuery.data ?? []

  const [tab, setTab] = React.useState<SessionTab>('live')
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [query, setQuery] = React.useState('')
  const [protocol, setProtocol] = React.useState<ProtocolFilter>('all')
  const [range, setRange] = React.useState<RangeFilter>('any')
  const [autoRefresh, setAutoRefresh] = React.useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<Date | null>(() => new Date())
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    if (!autoRefresh) {
      return undefined
    }
    const id = window.setInterval(() => {
      void qc.invalidateQueries({ queryKey: ['sessions'] })
      setLastRefreshedAt(new Date())
    }, 5000)
    return () => window.clearInterval(id)
  }, [autoRefresh, qc])

  // tick every 15s so the "Updated 30s ago" label drifts forward even when idle
  React.useEffect(() => {
    const id = window.setInterval(forceTick, 15000)
    return () => window.clearInterval(id)
  }, [])

  const sourceForTab: Record<SessionTab, LiveSession[]> = {
    live,
    past,
    management: [],
  }
  const baseRows = sourceForTab[tab]

  const filteredRows = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return baseRows.filter((session) => {
      if (!matchesProtocol(session, protocol)) {
        return false
      }
      if (!matchesRange(session, range)) {
        return false
      }
      if (q && ![session.id, session.user, session.target].some(field => field.toLowerCase().includes(q))) {
        return false
      }
      return true
    })
  }, [baseRows, protocol, query, range])

  const allSelected = filteredRows.length > 0 && filteredRows.every(session => selected.has(session.id))
  const someSelected = filteredRows.some(session => selected.has(session.id)) && !allSelected

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set())
    }
    else {
      setSelected(new Set(filteredRows.map(session => session.id)))
    }
  }

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      }
      else {
        next.add(id)
      }
      return next
    })
  }

  const onTabChange = (next: string) => {
    setTab(next as SessionTab)
    setSelected(new Set())
  }

  const onRefresh = () => {
    void qc.invalidateQueries({ queryKey: ['sessions'] })
    setLastRefreshedAt(new Date())
  }

  const onBulkAction = async () => {
    const ids = filteredRows.filter(session => selected.has(session.id)).map(session => session.id)
    if (ids.length === 0) {
      return
    }
    await forceClose.mutateAsync(ids)
    setSelected(new Set())
  }

  const [pending, setPending] = React.useState<
    | { kind: 'deleteOne', session: LiveSession }
    | { kind: 'deleteSelected', ids: string[] }
    | { kind: 'clearHistory' }
    | null
  >(null)

  const onBulkDelete = () => {
    const ids = filteredRows.filter(session => selected.has(session.id)).map(session => session.id)
    if (ids.length === 0) {
      return
    }
    setPending({ kind: 'deleteSelected', ids })
  }

  const onClearHistory = () => {
    setPending({ kind: 'clearHistory' })
  }

  const onDeleteOne = (session: LiveSession) => {
    setPending({ kind: 'deleteOne', session })
  }

  const runPending = async () => {
    if (!pending) {
      return
    }
    if (pending.kind === 'deleteOne') {
      await deleteSessions.mutateAsync([pending.session.id])
    }
    else if (pending.kind === 'deleteSelected') {
      await deleteSessions.mutateAsync(pending.ids)
      setSelected(new Set())
    }
    else {
      await clearHistory.mutateAsync()
      setSelected(new Set())
    }
    setPending(null)
  }

  const pendingBody = pending?.kind === 'deleteOne'
    ? t('monitor.sessions.confirm.deleteOne')
    : pending?.kind === 'deleteSelected'
      ? t('monitor.sessions.confirm.deleteSelected', { count: pending.ids.length })
      : t('monitor.sessions.confirm.clearHistory')

  const openDetail = (session: LiveSession) => {
    void navigate({ to: '/admin/sessions/$sessionId', params: { sessionId: session.id } })
  }

  const watchLive = (session: LiveSession) => {
    void navigate({ to: '/admin/sessions/$sessionId/monitor', params: { sessionId: session.id } })
  }

  // Replay opens the recording player directly. Resolve the session's latest
  // recording on click; if there is none (or the lookup fails) fall back to the
  // detail page, which shows the "no recording" state.
  const handleReplay = async (session: LiveSession) => {
    try {
      const recs = await getSessionRecordings(session.id)
      const first = recs[0]
      if (first) {
        void navigate({ to: '/admin/recordings/$recordingId', params: { recordingId: first.id } })
        return
      }
    }
    catch {}
    openDetail(session)
  }

  // Client-side CSV of the rows currently shown (tab + filters applied).
  const exportCsv = () => {
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
    const lines = [
      ['id', 'user', 'target', 'protocol', 'started', 'duration', 'state'].join(','),
      ...filteredRows.map(session =>
        [session.id, session.user, session.target, session.protocol, session.started, session.duration, session.state]
          .map(escape)
          .join(',')),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `gated-sessions-${tab}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const sshCount = live.filter(session => session.protocol.startsWith('ssh')).length
  const dbCount = live.length - sshCount

  const updatedLabel = lastRefreshedAt
    ? t('monitor.sessions.lastUpdated', { when: formatRelative(lastRefreshedAt) })
    : t('monitor.sessions.neverUpdated')

  const emptyMessage = tab === 'live'
    ? { title: t('monitor.sessions.emptyLive'), hint: t('monitor.sessions.emptyHintLive') }
    : { title: t('monitor.sessions.emptyPast'), hint: t('monitor.sessions.emptyHintPast') }

  return (
    <>
      <PageHeader
        title={t('nav.adminSessions')}
        description={t('monitor.sessions.description')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminSessions') },
        ]}
        actions={(
          <>
            {tab === 'past'
              ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => { void onClearHistory() }}
                    disabled={past.length === 0 || clearHistory.isPending}
                  >
                    <Trash2 size={13} />
                    <span>{t('monitor.sessions.actions.clearHistory')}</span>
                  </Button>
                )
              : null}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={filteredRows.length === 0}>
              <Download size={13} />
              <span>{t('monitor.sessions.actions.exportCsv')}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw size={13} className={liveQuery.isFetching ? 'animate-spin' : undefined} />
              <span>{t('actions.refresh')}</span>
            </Button>
            <label className="flex h-[30px] max-w-full items-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-[12.5px] text-muted-foreground">
              <Switch
                checked={autoRefresh}
                onCheckedChange={(value) => {
                  setAutoRefresh(value)
                  if (value) {
                    setLastRefreshedAt(new Date())
                  }
                }}
                aria-label={autoRefresh
                  ? t('a11y.admin.monitor.sessions.autoRefreshOn')
                  : t('a11y.admin.monitor.sessions.autoRefreshOff')}
              />
              <span>{t('monitor.sessions.actions.autoRefresh')}</span>
              <span
                className="tabular text-muted-foreground/80"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span aria-hidden="true">·&nbsp;</span>
                {updatedLabel}
              </span>
            </label>
          </>
        )}
        tabs={(
          <Tabs value={tab} onChange={onTabChange}>
            <TabsList>
              <TabsTrigger value="live">
                <span aria-hidden="true" className="pulse-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--info))]" />
                {t('monitor.sessions.tabs.live')}
                <span className="ml-1.5 tabular text-muted-foreground">
                  <span aria-hidden="true">·&nbsp;</span>
                  {live.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="past">
                {t('monitor.sessions.tabs.past')}
                <span className="ml-1.5 tabular text-muted-foreground">
                  <span aria-hidden="true">·&nbsp;</span>
                  {past.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="management">
                {t('monitor.sessions.management.tab')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      />

      {tab === 'management' ? <ManagementSessionsPanel /> : null}
      <div hidden={tab === 'management'}>
        <div className="grid grid-cols-1 gap-3 px-6 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Activity}
            label={t('monitor.sessions.stats.liveNow')}
            value={live.length}
            hint={t('monitor.sessions.stats.liveNowHint', { ssh: sshCount, db: dbCount })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
          <div className="w-[320px]">
            <Input
              icon={Search}
              placeholder={t('monitor.sessions.searchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </div>
          <Select
            className="w-[160px]"
            value={protocol}
            onValueChange={value => setProtocol(value as ProtocolFilter)}
            options={[
              { value: 'all', label: t('monitor.sessions.filter.allProtocols') },
              { value: 'ssh', label: 'SSH' },
              { value: 'mysql', label: 'MySQL' },
              { value: 'pg', label: 'PostgreSQL' },
              { value: 'http', label: 'HTTP' },
            ]}
          />
          <Select
            className="w-[160px]"
            value={range}
            onValueChange={value => setRange(value as RangeFilter)}
            options={[
              { value: 'any', label: t('monitor.sessions.filter.anyTime') },
              { value: '1h', label: t('monitor.sessions.filter.lastHour') },
              { value: '24h', label: t('monitor.sessions.filter.last24h') },
              { value: '7d', label: t('monitor.sessions.filter.last7d') },
            ]}
          />
          {(query || protocol !== 'all' || range !== 'any')
            ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQuery('')
                    setProtocol('all')
                    setRange('any')
                  }}
                >
                  {t('actions.clearFilters')}
                </Button>
              )
            : null}
          <span className="flex-1" />
        </div>

        <BulkActionBar
          selectedCount={selected.size}
          onClear={() => setSelected(new Set())}
        >
          {tab === 'live'
            ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => { void onBulkAction() }}
                >
                  <X size={13} />
                  <span>{t('monitor.sessions.actions.forceClose')}</span>
                </Button>
              )
            : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => { void onBulkDelete() }}
          >
            <Trash2 size={13} />
            <span>{t('monitor.sessions.actions.deleteSelected')}</span>
          </Button>
        </BulkActionBar>

        <ConfirmDialog
          open={pending !== null}
          title={t('monitor.sessions.confirm.title')}
          body={pendingBody}
          confirmLabel={t('monitor.sessions.actions.delete')}
          destructive
          onCancel={() => setPending(null)}
          onConfirm={() => { void runPending() }}
        />

        <div className="px-6 pb-6">
          {filteredRows.length === 0
            ? (
                <EmptyState
                  icon={Activity}
                  title={emptyMessage.title}
                  description={emptyMessage.hint}
                />
              )
            : (
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-[44px] pl-5">
                        <Checkbox
                          checked={allSelected}
                          indeterminate={someSelected}
                          onCheckedChange={toggleAll}
                          aria-label={t('a11y.admin.monitor.sessions.selectAll')}
                        />
                      </TH>
                      <TH>{t('monitor.sessions.fields.session')}</TH>
                      <TH>{t('fields.user')}</TH>
                      <TH>{t('fields.target')}</TH>
                      <TH>{t('fields.protocol')}</TH>
                      <TH>{t('fields.started')}</TH>
                      <TH>{t('fields.duration')}</TH>
                      <TH>{t('fields.status')}</TH>
                      <TH className="pr-5 text-right">{t('fields.actions')}</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filteredRows.map(session => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        checked={selected.has(session.id)}
                        onToggle={() => toggleOne(session.id)}
                        onOpen={() => openDetail(session)}
                        onWatchLive={() => watchLive(session)}
                        onForceClose={() => { void forceClose.mutateAsync([session.id]) }}
                        onReplay={() => { void handleReplay(session) }}
                        onDelete={() => onDeleteOne(session)}
                      />
                    ))}
                  </TBody>
                </Table>
              )}
        </div>
      </div>
    </>
  )
}

function ManagementSessionsPanel() {
  const { t } = useTranslation()
  const sessions = useManagementSessions()
  const revoke = useRevokeManagementSession()
  const [pending, setPending] = React.useState<ManagementSession | null>(null)
  const rows = sessions.data ?? []

  return (
    <div className="px-6 pb-6 pt-4">
      <ConfirmDialog
        open={pending !== null}
        title={t('monitor.sessions.management.confirmTitle')}
        body={t('monitor.sessions.management.confirmBody', { user: pending?.username ?? '' })}
        confirmLabel={t('monitor.sessions.management.revoke')}
        destructive
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending)
            void revoke.mutateAsync(pending.id).finally(() => setPending(null))
        }}
      />
      {sessions.isLoading
        ? <Skeleton className="h-24 w-full" />
        : rows.length === 0
          ? (
              <EmptyState
                icon={Activity}
                title={t('monitor.sessions.management.empty')}
                description={t('monitor.sessions.management.emptyHint')}
              />
            )
          : (
              <Table>
                <THead>
                  <TR>
                    <TH className="pl-5">{t('fields.user')}</TH>
                    <TH>{t('monitor.sessions.management.created')}</TH>
                    <TH>{t('monitor.sessions.management.lastActive')}</TH>
                    <TH className="pr-5 text-right">{t('fields.actions')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map(session => (
                    <TR key={session.id}>
                      <TD className="pl-5">
                        <span className="font-medium">{session.username}</span>
                        {session.current
                          ? <Badge className="ml-2">{t('monitor.sessions.management.current')}</Badge>
                          : null}
                      </TD>
                      <TD className="tabular">{new Date(session.created).toLocaleString()}</TD>
                      <TD className="tabular">{formatRelative(new Date(session.last_active))}</TD>
                      <TD className="pr-5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setPending(session)}
                        >
                          <X size={13} />
                          <span>{t('monitor.sessions.management.revoke')}</span>
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
    </div>
  )
}

function SessionRow({ session, checked, onToggle, onOpen, onWatchLive, onForceClose, onReplay, onDelete }: {
  session: LiveSession
  checked: boolean
  onToggle: () => void
  onOpen: () => void
  onWatchLive: () => void
  onForceClose: () => void
  onReplay: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const isLive = session.state === 'live'
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation()
  return (
    <TR onClick={onOpen}>
      <TD className="pl-5" onClick={stop}>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          aria-label={t('a11y.admin.monitor.sessions.selectRow', { id: session.id })}
        />
      </TD>
      <TD className="mono text-[12.5px]">{session.id}</TD>
      <TD>
        <div className="flex items-center gap-2">
          <Avatar name={session.user} size={24} />
          <span>{session.user}</span>
        </div>
      </TD>
      <TD className="mono text-[12.5px]">{session.target}</TD>
      <TD><Badge tone="mono">{session.protocol}</Badge></TD>
      <TD className="mono tabular text-[12.5px] text-muted-foreground">{session.started}</TD>
      <TD className="mono tabular text-[12.5px]">{session.duration}</TD>
      <TD>
        {isLive
          ? (
              <Badge tone="info">
                <span aria-hidden="true" className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--info))]" />
                <span>{t('status.live')}</span>
              </Badge>
            )
          : <Badge tone="mono">{t('status.closed')}</Badge>}
      </TD>
      <TD className="pr-5 text-right" onClick={stop}>
        <div className="flex items-center justify-end gap-1">
          {isLive
            ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t('monitor.sessions.actions.watchLive')}
                    aria-label={t('monitor.sessions.actions.watchLive')}
                    onClick={onWatchLive}
                  >
                    <Eye size={14} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t('monitor.sessions.actions.forceClose')}
                    aria-label={t('monitor.sessions.actions.forceClose')}
                    onClick={onForceClose}
                  >
                    <X size={14} aria-hidden="true" />
                  </Button>
                </>
              )
            : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={t('monitor.sessions.actions.replay')}
                  aria-label={t('monitor.sessions.actions.replay')}
                  onClick={onReplay}
                >
                  <Play size={14} aria-hidden="true" />
                </Button>
              )}
          <DropdownMenu
            trigger={(
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('monitor.sessions.actions.more')}
                aria-label={t('monitor.sessions.actions.more')}
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </Button>
            )}
            items={[
              { label: t('monitor.sessions.actions.viewDetail'), icon: Eye, onClick: onOpen },
              {
                label: t('monitor.sessions.actions.copyId'),
                icon: FileText,
                onClick: () => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard)
                    void navigator.clipboard.writeText(session.id).catch(() => {})
                },
              },
              { label: t('monitor.sessions.actions.delete'), icon: Trash2, danger: true, onClick: onDelete },
            ]}
          />
        </div>
      </TD>
    </TR>
  )
}
