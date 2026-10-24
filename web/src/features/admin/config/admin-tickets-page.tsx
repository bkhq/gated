import type { SortDir } from '@/shared/components/sort'
import type { Ticket } from '@/shared/types/domain'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Clock, Copy, Filter, Hash, Inbox, Key, Plus, Search, Trash2, X as XIcon } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { TicketFormDialog } from '@/features/tickets/components'
import { useDeleteTicket, useRevokeTicket, useTickets } from '@/features/tickets/hooks/use-tickets-queries'
import { ticketDeleteWarning, ticketUsesLabel } from '@/features/tickets/lib/uses'
import { BulkActionBar } from '@/shared/components/bulk-action-bar'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { Pager } from '@/shared/components/pager'
import { RowActionsMenu } from '@/shared/components/row-actions-menu'
import { ariaSort } from '@/shared/components/sort'
import { SortHeader } from '@/shared/components/sort-header'
import { StatCard } from '@/shared/components/stat-card'
import { formatTicketExpiresIn, isTicketExpiringSoon } from '@/shared/types/domain'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const STATE_KEYS = ['all', 'active', 'consumed', 'expired'] as const

type StateFilter = (typeof STATE_KEYS)[number]
const PAGE_SIZE = 20

type SortKey = 'name' | 'issuedBy' | 'usedCount' | 'expiresAt'

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
    case 'issuedBy': return ticket.issuedBy.toLowerCase()
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

export function AdminTicketsPage() {
  const { t } = useTranslation()
  const ticketsQuery = useTickets()
  const revokeMutation = useRevokeTicket()
  const deleteMutation = useDeleteTicket()
  const ticketsData = ticketsQuery.data
  const tickets = React.useMemo(() => ticketsData ?? [], [ticketsData])

  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Ticket | null>(null)
  const [pendingRevoke, setPendingRevoke] = React.useState<Ticket | null>(null)
  const [pendingBulk, setPendingBulk] = React.useState<'revoke' | 'delete' | null>(null)
  const [stateFilter, setStateFilter] = React.useState<StateFilter>('all')
  const [issuerFilter, setIssuerFilter] = React.useState<string>('all')
  const [query, setQuery] = React.useState('')
  const [offset, setOffset] = React.useState(0)
  const [sortKey, setSortKey] = React.useState<SortKey>('expiresAt')
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())

  // tick every 30s so relative-time display drifts even when idle
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    const id = window.setInterval(forceTick, 30_000)
    return () => window.clearInterval(id)
  }, [])

  const issuers = React.useMemo(() => {
    const set = new Set<string>()
    for (const ticket of tickets) {
      set.add(ticket.issuedBy)
    }
    return Array.from(set).sort()
  }, [tickets])

  const filtersActive = stateFilter !== 'all' || issuerFilter !== 'all' || query.trim().length > 0

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const result = tickets.filter((ticket) => {
      if (stateFilter !== 'all' && ticket.state !== stateFilter) {
        return false
      }
      if (issuerFilter !== 'all' && ticket.issuedBy !== issuerFilter) {
        return false
      }
      if (needle) {
        const haystack = `${ticket.name} ${ticket.scope} ${ticket.purpose} ${ticket.issuedBy} ${ticket.id}`.toLowerCase()
        if (!haystack.includes(needle)) {
          return false
        }
      }
      return true
    })
    return result.sort((a, b) => compare(a, b, sortKey, sortDir))
  }, [tickets, stateFilter, issuerFilter, query, sortKey, sortDir])
  // Clamped so a filter that shrinks the list never leaves an empty page.
  const pageOffset = Math.min(offset, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1) * PAGE_SIZE)
  const paged = filtered.slice(pageOffset, pageOffset + PAGE_SIZE)

  const allSelected = paged.length > 0 && paged.every(item => selected.has(item.id))
  const someSelected = !allSelected && paged.some(item => selected.has(item.id))

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set())
    }
    else {
      setSelected(new Set(paged.map(item => item.id)))
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

  const activeCount = tickets.filter(item => item.state === 'active').length
  const consumedCount = tickets.filter(item => item.state === 'consumed').length
  const expiredCount = tickets.filter(item => item.state === 'expired').length
  const expiringSoonCount = tickets.filter(item => isTicketExpiringSoon(item)).length

  const stats = [
    { label: t('tickets.stats.total'), value: String(tickets.length), icon: Key, hint: undefined as string | undefined },
    { label: t('tickets.stats.active'), value: String(activeCount), icon: Clock, hint: t('tickets.stats.activeHint', { count: expiringSoonCount }) },
    { label: t('tickets.stats.consumed'), value: String(consumedCount), icon: Hash, hint: undefined },
    { label: t('tickets.stats.expired'), value: String(expiredCount), icon: XIcon, hint: undefined },
  ]

  const setSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    }
    else {
      setSortKey(key)
      setSortDir(key === 'expiresAt' ? 'asc' : 'asc')
    }
  }

  const clearFilters = () => {
    setStateFilter('all')
    setIssuerFilter('all')
    setQuery('')
  }

  const selectedTickets = React.useMemo(
    () => filtered.filter(item => selected.has(item.id)),
    [filtered, selected],
  )
  const selectedHasActive = selectedTickets.some(item => item.state === 'active')

  const onBulkRevoke = async () => {
    for (const item of selectedTickets) {
      if (item.state === 'active') {
        await revokeMutation.mutateAsync(item.id)
      }
    }
    setSelected(new Set())
    setPendingBulk(null)
  }

  const onBulkDelete = async () => {
    for (const item of selectedTickets) {
      await deleteMutation.mutateAsync(item.id)
    }
    setSelected(new Set())
    setPendingBulk(null)
  }

  const isLoading = ticketsQuery.isLoading
  const showEmpty = !isLoading && tickets.length === 0
  const showFilteredEmpty = !isLoading && tickets.length > 0 && filtered.length === 0

  return (
    <>
      <PageHeader
        title={t('nav.adminTickets')}
        description={t('tickets.description')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminTickets') },
        ]}
        actions={(
          <Button size="sm" onClick={() => setDrawer({ mode: 'create', ticket: null })}>
            <Plus size={13} />
            <span>{t('tickets.actions.newTicket')}</span>
          </Button>
        )}
      />

      <div className="grid gap-3 px-6 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(stat => (
          <StatCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} hint={stat.hint} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[320px]">
          <Input
            icon={Search}
            placeholder={t('tickets.searchPlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOffset(0)
            }}
            aria-label={t('actions.search')}
          />
        </div>
        <Select
          className="w-[140px]"
          value={stateFilter}
          onValueChange={(value) => {
            setStateFilter(value as StateFilter)
            setOffset(0)
          }}
          aria-label={t('tickets.filter.state')}
          options={STATE_KEYS.map(key => ({
            value: key,
            label: key === 'all' ? t('tickets.filter.allState') : t(`tickets.state.${key}`),
          }))}
        />
        <Select
          className="w-[180px]"
          value={issuerFilter}
          onValueChange={setIssuerFilter}
          aria-label={t('tickets.filter.issuer')}
          options={[
            { value: 'all', label: t('tickets.filter.allIssuers') },
            ...issuers.map(issuer => ({ value: issuer, label: issuer })),
          ]}
        />
        {filtersActive
          ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span className="text-[12px] text-muted-foreground">
          {filtered.length}
          {' / '}
          {tickets.length}
        </span>
      </div>

      <BulkActionBar
        selectedCount={selectedTickets.length}
        onClear={() => setSelected(new Set())}
      >
        {selectedHasActive
          ? (
              <Button variant="ghost" size="sm" onClick={() => setPendingBulk('revoke')}>
                <XIcon size={13} />
                <span>{t('tickets.actions.revokeSelected')}</span>
              </Button>
            )
          : null}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setPendingBulk('delete')}
        >
          <Trash2 size={13} />
          <span>{t('tickets.actions.deleteSelected')}</span>
        </Button>
      </BulkActionBar>

      <div className="px-6 pb-6">
        {isLoading
          ? <TicketsTableSkeleton />
          : showEmpty
            ? (
                <EmptyState
                  icon={Inbox}
                  title={t('tickets.empty.title')}
                  description={t('tickets.empty.description')}
                  action={(
                    <Button size="sm" onClick={() => setDrawer({ mode: 'create', ticket: null })}>
                      <Plus size={13} />
                      <span>{t('tickets.actions.newTicket')}</span>
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
                        <TH className="w-[44px] pl-5">
                          <Checkbox
                            checked={allSelected}
                            indeterminate={someSelected}
                            onCheckedChange={toggleAll}
                            aria-label={t('tickets.selectAll')}
                            aria-checked={someSelected ? 'mixed' : allSelected}
                          />
                        </TH>
                        <TH aria-sort={ariaSort(sortKey === 'name', sortDir)}>
                          <SortHeader label={t('fields.name')} active={sortKey === 'name'} dir={sortDir} onClick={() => setSort('name')} />
                        </TH>
                        <TH>{t('tickets.fields.scope')}</TH>
                        <TH aria-sort={ariaSort(sortKey === 'issuedBy', sortDir)}>
                          <SortHeader label={t('tickets.fields.issuedBy')} active={sortKey === 'issuedBy'} dir={sortDir} onClick={() => setSort('issuedBy')} />
                        </TH>
                        <TH aria-sort={ariaSort(sortKey === 'usedCount', sortDir)}>
                          <SortHeader label={t('tickets.fields.uses')} active={sortKey === 'usedCount'} dir={sortDir} onClick={() => setSort('usedCount')} />
                        </TH>
                        <TH aria-sort={ariaSort(sortKey === 'expiresAt', sortDir)}>
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
                          checked={selected.has(ticket.id)}
                          onToggle={() => toggleOne(ticket.id)}
                          onOpen={() => setDrawer({ mode: 'edit', ticket })}
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
      />

      <Dialog open={pendingRevoke !== null} onClose={() => setPendingRevoke(null)} width={440}>
        <div className="flex flex-col">
          <div className="px-6 pb-3 pt-5">
            <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">{t('tickets.revoke.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
              {t('tickets.revoke.body', { name: pendingRevoke?.name ?? '' })}
            </DialogPrimitive.Description>
            <div className="mt-3 rounded-md border border-border bg-[hsl(var(--muted)/0.4)] p-3 text-[12.5px] text-muted-foreground">
              {t('tickets.revoke.auditHint')}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setPendingRevoke(null)}>{t('actions.cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = pendingRevoke
                if (!target) {
                  return
                }
                setPendingRevoke(null)
                void revokeMutation.mutateAsync(target.id)
              }}
              disabled={revokeMutation.isPending}
            >
              {t('tickets.actions.revoke')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={pendingDelete !== null} onClose={() => setPendingDelete(null)} width={440}>
        <div className="flex flex-col">
          <div className="px-6 pb-3 pt-5">
            <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">{t('tickets.delete.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
              {t('tickets.delete.body', { name: pendingDelete?.name ?? '' })}
            </DialogPrimitive.Description>
            {pendingDelete?.state === 'active'
              ? (
                  <div className="mt-3 rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[12.5px] text-[hsl(var(--warning))]">
                    <div className="font-semibold">{t('tickets.delete.warnTitle')}</div>
                    <div className="text-muted-foreground">
                      {ticketDeleteWarning(t, pendingDelete.usesLeft)}
                    </div>
                  </div>
                )
              : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setPendingDelete(null)}>{t('actions.cancel')}</Button>
            {pendingDelete?.state === 'active'
              ? (
                  <Button
                    onClick={() => {
                      const target = pendingDelete
                      if (!target) {
                        return
                      }
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
                      if (!target) {
                        return
                      }
                      setPendingDelete(null)
                      void deleteMutation.mutateAsync(target.id)
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    {t('actions.delete')}
                  </Button>
                )}
          </div>
        </div>
      </Dialog>

      <Dialog open={pendingBulk !== null} onClose={() => setPendingBulk(null)} width={460}>
        <div className="flex flex-col">
          <div className="px-6 pb-3 pt-5">
            <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">
              {pendingBulk === 'revoke' ? t('tickets.bulk.revokeTitle') : t('tickets.bulk.deleteTitle')}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
              {pendingBulk === 'revoke'
                ? t('tickets.bulk.revokeBody', { count: selectedTickets.filter(item => item.state === 'active').length })
                : t('tickets.bulk.deleteBody', { count: selectedTickets.length })}
            </DialogPrimitive.Description>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setPendingBulk(null)}>{t('actions.cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingBulk === 'revoke') {
                  void onBulkRevoke()
                }
                else if (pendingBulk === 'delete') {
                  void onBulkDelete()
                }
              }}
              disabled={revokeMutation.isPending || deleteMutation.isPending}
            >
              {pendingBulk === 'revoke' ? t('tickets.actions.revoke') : t('actions.delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}

function TicketRow({ ticket, checked, onToggle, onOpen, onRevoke, onDelete }: {
  ticket: Ticket
  checked: boolean
  onToggle: () => void
  onOpen: () => void
  onRevoke: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const soon = isTicketExpiringSoon(ticket)
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation()

  return (
    <TR onClick={onOpen}>
      <TD className="pl-5" onClick={stop}>
        <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={t('tickets.selectRow', { name: ticket.name })} />
      </TD>
      <TD>
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
            <Key size={15} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium">{ticket.name}</div>
            <div className="mono truncate text-[12px] text-muted-foreground">{ticket.id}</div>
          </div>
        </div>
      </TD>
      <TD>
        <span className="mono truncate text-[12.5px]">{ticket.scope}</span>
      </TD>
      <TD className="text-[12.5px] text-muted-foreground">{ticket.issuedBy}</TD>
      <TD className="mono tabular text-[12.5px]">{ticketUsesLabel(t, ticket.usesLeft)}</TD>
      <TD>
        <div className="flex items-center gap-1.5">
          {soon
            ? (
                <>
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--destructive))]"
                    aria-hidden="true"
                  />
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
        <RowActionsMenu
          items={[
            { label: t('tickets.form.details'), icon: Key, onClick: onOpen },
            { label: t('tickets.actions.copyLink'), icon: Copy, onClick: () => { void navigator.clipboard?.writeText(`${window.location.origin}/claim/${ticket.id}`) } },
            ...(ticket.state === 'active'
              ? [
                  { label: t('tickets.actions.revoke'), icon: XIcon, onClick: onRevoke },
                ]
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
          <TH className="w-[44px] pl-5"><Skeleton className="h-4 w-4 rounded" /></TH>
          <TH><Skeleton className="h-3.5 w-20" /></TH>
          <TH><Skeleton className="h-3.5 w-16" /></TH>
          <TH><Skeleton className="h-3.5 w-16" /></TH>
          <TH><Skeleton className="h-3.5 w-12" /></TH>
          <TH><Skeleton className="h-3.5 w-12" /></TH>
          <TH><Skeleton className="h-3.5 w-12" /></TH>
          <TH className="pr-5" />
        </TR>
      </THead>
      <TBody>
        {Array.from({ length: 5 }).map((_, index) => (
          <TR key={`tk-skel-${String(index)}`}>
            <TD className="pl-5"><Skeleton className="h-4 w-4 rounded" /></TD>
            <TD>
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            </TD>
            <TD><Skeleton className="h-3.5 w-28" /></TD>
            <TD><Skeleton className="h-3.5 w-20" /></TD>
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
