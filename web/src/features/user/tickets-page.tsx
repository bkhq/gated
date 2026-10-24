import type { Ticket } from '@/shared/types/domain'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Clock,
  Copy,
  Filter,
  Hash,
  Inbox,
  Info,
  Key,
  MoreHorizontal,
  Plus,
  Search,
  Ticket as TicketIcon,
  Trash2,
  X as XIcon,
  Zap,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TicketFormDialog } from '@/features/tickets/components'
import { useDeleteTicket, useMyTickets, useRevokeTicket } from '@/features/tickets/hooks/use-tickets-queries'
import { ticketDeleteWarning, ticketUsesLabel } from '@/features/tickets/lib/uses'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { Pager } from '@/shared/components/pager'
import { StatCard } from '@/shared/components/stat-card'
import { formatTicketExpiresIn, isTicketExpiringSoon } from '@/shared/types/domain'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { useAppStore } from '@/store/app-store'

const STATE_KEYS = ['all', 'active', 'consumed', 'expired'] as const
type StateFilter = (typeof STATE_KEYS)[number]
const PAGE_SIZE = 20

type SortKey = 'name' | 'usedCount' | 'expiresAt'
type SortDir = 'asc' | 'desc'

interface DrawerState {
  mode: 'create' | 'edit'
  ticket: Ticket | null
}

const STATE_TONE: Record<Ticket['state'], 'success' | 'mono' | 'warning'> = {
  active: 'success',
  consumed: 'mono',
  expired: 'warning',
}

function sortValue(ticket: Ticket, key: SortKey): string | number {
  switch (key) {
    case 'name': return ticket.name.toLowerCase()
    case 'usedCount': return ticket.usesLeft ?? Number.POSITIVE_INFINITY
    case 'expiresAt': return new Date(ticket.expiresAt).getTime() || 0
  }
}

function compare(a: Ticket, b: Ticket, key: SortKey, dir: SortDir): number {
  const av = sortValue(a, key)
  const bv = sortValue(b, key)
  let result = 0
  if (typeof av === 'number' && typeof bv === 'number') {
    result = av - bv
  }
  else {
    result = String(av).localeCompare(String(bv))
  }
  return dir === 'asc' ? result : -result
}

export function TicketsPage() {
  const { t } = useTranslation()
  const identity = useAppStore(state => state.identity)
  const ticketsQuery = useMyTickets(identity.username)
  const revokeMutation = useRevokeTicket()
  const deleteMutation = useDeleteTicket()

  const allTickets = ticketsQuery.data
  const tickets = React.useMemo(() => allTickets ?? [], [allTickets])

  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [pendingRevoke, setPendingRevoke] = React.useState<Ticket | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Ticket | null>(null)
  const [shareSecret, setShareSecret] = React.useState<string | null>(null)
  const [stateFilter, setStateFilter] = React.useState<StateFilter>('all')
  const [query, setQuery] = React.useState('')
  const [offset, setOffset] = React.useState(0)
  const [sortKey, setSortKey] = React.useState<SortKey>('expiresAt')
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')
  const [liveMsg, setLiveMsg] = React.useState('')

  const [, forceTick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    const id = window.setInterval(forceTick, 30_000)
    return () => window.clearInterval(id)
  }, [])

  const filtersActive = stateFilter !== 'all' || query.trim().length > 0

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const out = tickets.filter((ticket) => {
      if (stateFilter !== 'all' && ticket.state !== stateFilter) {
        return false
      }
      if (needle) {
        const haystack = `${ticket.name} ${ticket.scope} ${ticket.purpose} ${ticket.id}`.toLowerCase()
        if (!haystack.includes(needle)) {
          return false
        }
      }
      return true
    })
    return out.sort((a, b) => compare(a, b, sortKey, sortDir))
  }, [tickets, stateFilter, query, sortKey, sortDir])
  // Clamped so a filter that shrinks the list never leaves an empty page.
  const pageOffset = Math.min(offset, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1) * PAGE_SIZE)
  const paged = filtered.slice(pageOffset, pageOffset + PAGE_SIZE)

  const activeCount = tickets.filter(item => item.state === 'active').length
  const consumedCount = tickets.filter(item => item.state === 'consumed').length
  const expiredCount = tickets.filter(item => item.state === 'expired').length
  const expiringSoonCount = tickets.filter(item => isTicketExpiringSoon(item)).length

  const stats = [
    { label: t('user.tickets.stats.active'), value: String(activeCount), icon: Clock, hint: t('user.tickets.stats.expiringHint', { count: expiringSoonCount }) },
    { label: t('user.tickets.stats.expiringSoon'), value: String(expiringSoonCount), icon: AlertTriangle, hint: undefined as string | undefined },
    { label: t('user.tickets.stats.consumed'), value: String(consumedCount), icon: Hash, hint: undefined },
    { label: t('user.tickets.stats.expired'), value: String(expiredCount), icon: XIcon, hint: undefined },
  ]

  const setSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    }
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const clearFilters = () => {
    setStateFilter('all')
    setQuery('')
  }

  const copyId = (id: string) => {
    void navigator.clipboard?.writeText(id)
    setLiveMsg(t('user.tickets.copiedId'))
    window.setTimeout(setLiveMsg, 1500, '')
  }

  // The share link carries the one-time ticket secret as ?gated-ticket=…;
  // TicketMiddleware authorizes the session from it on any URL, so the link
  // works without a prior login. The secret only exists at creation time.
  const shareLink = shareSecret
    ? `${window.location.origin}/?gated-ticket=${encodeURIComponent(shareSecret)}`
    : null

  const copyShareLink = () => {
    if (!shareLink)
      return
    void navigator.clipboard?.writeText(shareLink)
    setLiveMsg(t('user.tickets.copiedLink'))
    window.setTimeout(setLiveMsg, 1500, '')
  }

  const isLoading = ticketsQuery.isLoading
  const showEmpty = !isLoading && tickets.length === 0
  const showFilteredEmpty = !isLoading && tickets.length > 0 && filtered.length === 0

  return (
    <>
      <PageHeader
        title={t('user.tickets.title')}
        description={t('user.tickets.description')}
        actions={(
          <Button size="sm" onClick={() => setDrawer({ mode: 'create', ticket: null })}>
            <Plus size={13} aria-hidden="true" />
            <span>{t('user.tickets.actions.issue')}</span>
          </Button>
        )}
      />

      <div className="px-6 pt-4">
        <Card>
          <CardContent className="flex flex-wrap items-start gap-3 p-3.5">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card"
              aria-hidden="true"
            >
              <Info size={14} />
            </div>
            <div className="grid min-w-0 flex-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <div>
                <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <TicketIcon size={12} aria-hidden="true" />
                  <span>{t('user.tickets.intro.ticketsTitle')}</span>
                </div>
                <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                  {t('user.tickets.intro.ticketsBody')}
                </p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Zap size={12} aria-hidden="true" />
                  <span>{t('user.tickets.intro.apiTokensTitle')}</span>
                </div>
                <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                  {t('user.tickets.intro.apiTokensBody')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 px-6 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(stat => (
          <StatCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} hint={stat.hint} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[280px]">
          <Input
            icon={Search}
            placeholder={t('user.tickets.searchPlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOffset(0)
            }}
            aria-label={t('a11y.user.tickets.search')}
          />
        </div>
        <Select
          className="w-[140px]"
          value={stateFilter}
          onValueChange={(value) => {
            setStateFilter(value as StateFilter)
            setOffset(0)
          }}
          aria-label={t('a11y.user.tickets.filterState')}
          options={STATE_KEYS.map(key => ({
            value: key,
            label: key === 'all' ? t('tickets.filter.allState') : t(`tickets.state.${key}`),
          }))}
        />
        {filtersActive
          ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span
          role="status"
          aria-live="polite"
          className="text-[12px] text-muted-foreground"
        >
          {filtered.length}
          {' / '}
          {tickets.length}
        </span>
      </div>

      <span className="sr-only" role="status" aria-live="polite">{liveMsg}</span>

      <div className="px-6 pb-6">
        {isLoading
          ? <TicketsTableSkeleton />
          : showEmpty
            ? (
                <EmptyState
                  icon={Inbox}
                  title={t('user.tickets.empty.title')}
                  description={t('user.tickets.empty.description')}
                  action={(
                    <Button size="sm" onClick={() => setDrawer({ mode: 'create', ticket: null })}>
                      <Plus size={13} aria-hidden="true" />
                      <span>{t('user.tickets.actions.issue')}</span>
                    </Button>
                  )}
                />
              )
            : showFilteredEmpty
              ? (
                  <EmptyState
                    icon={Filter}
                    title={t('tickets.empty.filteredTitle')}
                    description={t('tickets.empty.filteredDescription')}
                    action={(
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        {t('actions.clearFilters')}
                      </Button>
                    )}
                  />
                )
              : (
                  <Table>
                    <THead>
                      <TR>
                        <TH aria-sort={sortKey === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className="pl-5">
                          <SortHeader label={t('fields.name')} active={sortKey === 'name'} dir={sortDir} onClick={() => setSort('name')} />
                        </TH>
                        <TH>{t('tickets.fields.scope')}</TH>
                        <TH aria-sort={sortKey === 'usedCount' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <SortHeader label={t('tickets.fields.uses')} active={sortKey === 'usedCount'} dir={sortDir} onClick={() => setSort('usedCount')} />
                        </TH>
                        <TH aria-sort={sortKey === 'expiresAt' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <SortHeader label={t('tickets.fields.expiresIn')} active={sortKey === 'expiresAt'} dir={sortDir} onClick={() => setSort('expiresAt')} />
                        </TH>
                        <TH>{t('fields.status')}</TH>
                        <TH className="pr-5 text-right" aria-label={t('fields.actions')} />
                      </TR>
                    </THead>
                    <TBody>
                      {paged.map(ticket => (
                        <TicketRow
                          key={ticket.id}
                          ticket={ticket}
                          onOpen={() => setDrawer({ mode: 'edit', ticket })}
                          onCopyId={() => copyId(ticket.id)}
                          onRevoke={() => setPendingRevoke(ticket)}
                          onDelete={() => setPendingDelete(ticket)}
                        />
                      ))}
                    </TBody>
                  </Table>
                )}
        <Pager offset={pageOffset} pageSize={PAGE_SIZE} total={filtered.length} onOffsetChange={setOffset} />
      </div>

      <TicketFormDialog
        open={drawer !== null}
        mode={drawer?.mode ?? 'create'}
        ticket={drawer?.ticket ?? null}
        onClose={() => setDrawer(null)}
        onSaved={(_, secret) => {
          if (secret)
            setShareSecret(secret)
        }}
      />

      <Dialog open={shareSecret !== null} onClose={() => setShareSecret(null)} width={560}>
        <DialogHeader
          title={t('user.tickets.share.title')}
          description={t('user.tickets.share.oneTimeHint')}
          onClose={() => setShareSecret(null)}
        />
        <DialogBody>
          <div className="mono break-all rounded-md border border-border bg-[hsl(var(--muted)/0.4)] p-3 text-[12.5px]">
            {shareLink}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShareSecret(null)}>{t('actions.close')}</Button>
          <Button onClick={copyShareLink}>
            <Copy size={13} />
            <span>{t('user.tickets.share.copy')}</span>
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={pendingRevoke !== null} onClose={() => setPendingRevoke(null)} width={460}>
        {pendingRevoke
          ? (
              <>
                <DialogHeader
                  title={t('tickets.revoke.title')}
                  description={t('tickets.revoke.body', { name: pendingRevoke.name })}
                  onClose={() => setPendingRevoke(null)}
                />
                <DialogBody>
                  <div className="rounded-md border border-border bg-[hsl(var(--muted)/0.4)] p-3 text-[12.5px] text-muted-foreground">
                    {t('tickets.revoke.auditHint')}
                  </div>
                </DialogBody>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setPendingRevoke(null)}>{t('actions.cancel')}</Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      const target = pendingRevoke
                      setPendingRevoke(null)
                      void revokeMutation.mutateAsync(target.id)
                    }}
                    disabled={revokeMutation.isPending}
                  >
                    {t('tickets.actions.revoke')}
                  </Button>
                </DialogFooter>
              </>
            )
          : null}
      </Dialog>

      <Dialog open={pendingDelete !== null} onClose={() => setPendingDelete(null)} width={460}>
        {pendingDelete
          ? (
              <>
                <DialogHeader
                  title={t('tickets.delete.title')}
                  description={t('tickets.delete.body', { name: pendingDelete.name })}
                  onClose={() => setPendingDelete(null)}
                />
                {pendingDelete.state === 'active'
                  ? (
                      <DialogBody>
                        <div className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[12.5px]">
                          <div className="font-semibold text-[hsl(var(--warning))]">{t('tickets.delete.warnTitle')}</div>
                          <div className="text-muted-foreground">{ticketDeleteWarning(t, pendingDelete.usesLeft)}</div>
                        </div>
                      </DialogBody>
                    )
                  : null}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setPendingDelete(null)}>{t('actions.cancel')}</Button>
                  {pendingDelete.state === 'active'
                    ? (
                        <Button
                          onClick={() => {
                            const target = pendingDelete
                            setPendingDelete(null)
                            void revokeMutation.mutateAsync(target.id)
                          }}
                          disabled={revokeMutation.isPending}
                        >
                          {t('tickets.delete.revokeInstead')}
                        </Button>
                      )
                    : (
                        <Button
                          variant="destructive"
                          onClick={() => {
                            const target = pendingDelete
                            setPendingDelete(null)
                            void deleteMutation.mutateAsync(target.id)
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          {t('actions.delete')}
                        </Button>
                      )}
                </DialogFooter>
              </>
            )
          : null}
      </Dialog>
    </>
  )
}

function SortHeader({ label, active, dir, onClick }: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-left transition hover:bg-[hsl(var(--accent)/0.55)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
      onClick={onClick}
    >
      <span>{label}</span>
      {active
        ? (
            dir === 'asc'
              ? <ArrowUp size={11} className="text-foreground" />
              : <ArrowDown size={11} className="text-foreground" />
          )
        : <ChevronsUpDown size={11} className="opacity-60" />}
    </button>
  )
}

function TicketRow({ ticket, onOpen, onCopyId, onRevoke, onDelete }: {
  ticket: Ticket
  onOpen: () => void
  onCopyId: () => void
  onRevoke: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const soon = isTicketExpiringSoon(ticket)
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation()

  return (
    <TR onClick={onOpen}>
      <TD className="pl-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
            <Key size={15} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium">{ticket.name}</div>
            <div className="mono truncate text-[11.5px] text-muted-foreground">{ticket.id}</div>
          </div>
        </div>
      </TD>
      <TD>
        <span className="mono truncate text-[12.5px]">{ticket.scope}</span>
      </TD>
      <TD className="mono tabular text-[12.5px]">{ticketUsesLabel(t, ticket.usesLeft)}</TD>
      <TD>
        <div className="flex items-center gap-1.5">
          {soon
            ? (
                <>
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--destructive))]" aria-hidden="true" />
                  <span className="sr-only">{t('tickets.expiresSoonLabel')}</span>
                </>
              )
            : null}
          <span className={`mono tabular text-[12.5px] ${soon ? 'text-[hsl(var(--destructive))]' : ''}`}>
            {ticket.state === 'active' ? formatTicketExpiresIn(ticket.expiresAt) : '—'}
          </span>
        </div>
      </TD>
      <TD>
        <Badge tone={STATE_TONE[ticket.state]}>{t(`tickets.state.${ticket.state}`)}</Badge>
      </TD>
      <TD className="pr-5 text-right" onClick={stop}>
        <DropdownMenu
          trigger={(
            <Button variant="ghost" size="icon-sm" aria-label={t('user.tickets.rowMenu', { name: ticket.name })}>
              <MoreHorizontal size={14} aria-hidden="true" />
            </Button>
          )}
          items={[
            { label: t('actions.open'), icon: Key, onClick: onOpen },
            { label: t('user.tickets.menu.copyId'), icon: Copy, onClick: onCopyId },
            ...(ticket.state === 'active'
              ? [{ label: t('tickets.actions.revoke'), icon: XIcon, onClick: onRevoke }]
              : []),
            'separator' as const,
            { label: t('actions.delete'), icon: Trash2, danger: true, onClick: onDelete },
          ]}
        />
      </TD>
    </TR>
  )
}

function TicketsTableSkeleton() {
  return (
    <Table>
      <THead>
        <TR>
          <TH className="pl-5"><Skeleton className="h-3.5 w-20" /></TH>
          <TH><Skeleton className="h-3.5 w-16" /></TH>
          <TH><Skeleton className="h-3.5 w-12" /></TH>
          <TH><Skeleton className="h-3.5 w-16" /></TH>
          <TH><Skeleton className="h-3.5 w-14" /></TH>
          <TH className="pr-5" />
        </TR>
      </THead>
      <TBody>
        {Array.from({ length: 4 }).map((_, index) => (
          <TR key={`ut-skel-${String(index)}`}>
            <TD className="pl-5">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            </TD>
            <TD><Skeleton className="h-3.5 w-28" /></TD>
            <TD><Skeleton className="h-3.5 w-12" /></TD>
            <TD><Skeleton className="h-3.5 w-16" /></TD>
            <TD><Skeleton className="h-5 w-14 rounded-full" /></TD>
            <TD className="pr-5 text-right"><Skeleton className="ml-auto h-7 w-7 rounded" /></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}
