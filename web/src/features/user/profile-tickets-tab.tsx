import type { Ticket } from '@/shared/types/domain'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle,
  Clock,
  Copy,
  Hash,
  Key,
  Link as LinkIcon,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useMyTickets, useRevokeTicket } from '@/features/tickets/hooks/use-tickets-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { StatCard } from '@/shared/components/stat-card'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { useAppStore } from '@/store/app-store'
import { ListSkeleton, RowMenu } from './profile-shared'

const TICKET_TONE: Record<Ticket['state'], 'success' | 'mono' | 'warning'> = {
  active: 'success',
  consumed: 'mono',
  expired: 'warning',
}

const TICKET_STATES = ['all', 'active', 'consumed', 'expired'] as const
type TicketStateFilter = (typeof TICKET_STATES)[number]

export function TicketsTab() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const identity = useAppStore(state => state.identity)
  const ticketsQuery = useMyTickets(identity.username)
  const revokeMutation = useRevokeTicket()

  const tickets = React.useMemo(() => ticketsQuery.data ?? [], [ticketsQuery.data])

  const [stateFilter, setStateFilter] = React.useState<TicketStateFilter>('all')
  const [query, setQuery] = React.useState('')
  const [pendingRevoke, setPendingRevoke] = React.useState<Ticket | null>(null)

  const filtered = React.useMemo(() => {
    return tickets.filter((ticket) => {
      if (stateFilter !== 'all' && ticket.state !== stateFilter) {
        return false
      }
      if (query) {
        const haystack = `${ticket.name} ${ticket.scope}`.toLowerCase()
        if (!haystack.includes(query.toLowerCase())) {
          return false
        }
      }
      return true
    })
  }, [tickets, stateFilter, query])

  const active = tickets.filter(ticket => ticket.state === 'active').length
  const consumed = tickets.filter(ticket => ticket.state === 'consumed').length
  const expired = tickets.filter(ticket => ticket.state === 'expired').length
  const expiringSoon = tickets.filter((ticket) => {
    if (ticket.state !== 'active') {
      return false
    }
    return /^\d+\s*h/u.test(ticket.expiresIn) || /^[0-2]\s*d/u.test(ticket.expiresIn)
  }).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-[12.5px] text-muted-foreground">{t('profile.tickets.description')}</p>
        <Button size="sm" variant="outline" onClick={() => { void navigate({ to: '/tickets' }) }}>
          <LinkIcon size={13} aria-hidden="true" />
          <span>{t('profile.tickets.newClaim')}</span>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('profile.tickets.stats.active')} value={String(active)} icon={Clock} />
        <StatCard label={t('profile.tickets.stats.consumed')} value={String(consumed)} icon={Hash} />
        <StatCard label={t('profile.tickets.stats.expired')} value={String(expired)} icon={X} />
        <StatCard label={t('profile.tickets.stats.expiring')} value={String(expiringSoon)} icon={AlertTriangle} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[280px]">
          <Input
            icon={Search}
            placeholder={t('profile.tickets.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('a11y.profile.ticketsSearch')}
          />
        </div>
        <Select
          className="w-[160px]"
          value={stateFilter}
          onValueChange={value => setStateFilter(value as TicketStateFilter)}
          options={TICKET_STATES.map(key => ({
            value: key,
            label: key === 'all' ? t('profile.tickets.filter.allState') : t(`tickets.state.${key}`),
          }))}
          aria-label={t('a11y.profile.ticketsFilterState')}
        />
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

      <Card>
        <CardContent className="p-0">
          {ticketsQuery.isLoading
            ? <ListSkeleton className="p-5" />
            : filtered.length === 0
              ? (
                  <div className="p-6">
                    <EmptyState
                      icon={Key}
                      title={t('profile.tickets.empty')}
                      description={t('profile.tickets.emptyHint')}
                    />
                  </div>
                )
              : (
                  <ul className="m-0 list-none divide-y divide-border p-0">
                    {filtered.map(ticket => (
                      <li key={ticket.id} className="flex items-center gap-3 px-5 py-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                          <Key size={15} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-medium">{ticket.name}</div>
                          <div className="mono mt-0.5 truncate text-[11px] text-muted-foreground">
                            {ticket.scope}
                            {' · '}
                            {ticket.uses}
                            {' · '}
                            {ticket.expiresIn}
                          </div>
                        </div>
                        <Badge tone={TICKET_TONE[ticket.state]}>{t(`tickets.state.${ticket.state}`)}</Badge>
                        <RowMenu
                          items={[
                            { label: t('profile.tickets.menu.copyLink'), icon: Copy },
                            { label: t('profile.tickets.menu.viewUsage'), icon: Hash },
                            ...(ticket.state === 'active'
                              ? ['separator' as const, { label: t('profile.actions.revoke'), icon: Trash2, danger: true, onClick: () => setPendingRevoke(ticket) }]
                              : []),
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>

      <Dialog open={pendingRevoke !== null} onClose={() => setPendingRevoke(null)} width={460}>
        {pendingRevoke
          ? (
              <>
                <DialogHeader
                  title={t('profile.tickets.revoke.title')}
                  description={t('profile.tickets.revoke.body', { name: pendingRevoke.name })}
                  onClose={() => setPendingRevoke(null)}
                />
                <DialogBody>
                  <div className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[13px]">
                    <div className="flex items-center gap-2 font-semibold text-[hsl(var(--warning))]">
                      <AlertTriangle size={14} aria-hidden="true" />
                      {t('profile.tickets.revoke.scope', { scope: pendingRevoke.scope })}
                    </div>
                  </div>
                </DialogBody>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setPendingRevoke(null)}>{t('actions.cancel')}</Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      void revokeMutation.mutateAsync(pendingRevoke.id)
                      setPendingRevoke(null)
                    }}
                  >
                    {t('profile.tickets.revoke.confirm')}
                  </Button>
                </DialogFooter>
              </>
            )
          : null}
      </Dialog>
    </div>
  )
}

// ===========================================================================
// Shared primitives
// ===========================================================================
