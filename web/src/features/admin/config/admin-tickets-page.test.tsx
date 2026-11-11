import type { Ticket } from '@/shared/types/domain'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AdminTicketsPage } from './admin-tickets-page'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => opts && 'from' in opts ? `${key}:${String(opts.from)}-${String(opts.to)}/${String(opts.total)}` : key }),
}))

const tickets: Ticket[] = Array.from({ length: 45 }, (_, i) => ({
  id: `t${i}`,
  name: `ticket-${String(i).padStart(2, '0')}`,
  scope: 'web-01',
  usesLeft: 1,
  usesLimit: 1,
  expiresIn: '1h',
  expiresAt: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
  issuedBy: 'admin',
  issuedAt: new Date().toISOString(),
  purpose: '',
  state: 'active',
}))

vi.mock('@/features/tickets/components', () => ({
  // Creating a ticket hands back its one-time secret.
  TicketFormDialog: ({ open, onSaved }: { open: boolean, onSaved?: (ticket: Ticket, secret?: string) => void }) => (
    open ? <button type="button" onClick={() => onSaved?.(tickets[0]!, 'secret-1')}>create</button> : null
  ),
  TicketShareDialog: ({ secret, targetName }: { secret: string | null, targetName: string | null }) => (
    secret ? <div>{`share:${secret}:${String(targetName)}`}</div> : null
  ),
}))

vi.mock('@/features/tickets/hooks/use-tickets-queries', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
  return {
    useTickets: () => ({ data: tickets, isLoading: false, isError: false }),
    useDeleteTicket: () => mutation,
    useRevokeTicket: () => mutation,
  }
})

afterEach(cleanup)

it('shows tickets twenty at a time', () => {
  render(<AdminTicketsPage />)
  expect(screen.getByText('ticket-00')).toBeTruthy()
  expect(screen.queryByText('ticket-20')).toBeNull()
  expect(screen.getByText('pagination.range:1-20/45')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /pagination.next/ }))
  expect(screen.getByText('ticket-20')).toBeTruthy()
  expect(screen.queryByText('ticket-00')).toBeNull()
})

it('shows the secret of a ticket it just created', () => {
  render(<AdminTicketsPage />)
  fireEvent.click(screen.getByRole('button', { name: /tickets.actions.newTicket/ }))
  fireEvent.click(screen.getByRole('button', { name: 'create' }))
  expect(screen.getByText('share:secret-1:web-01')).toBeTruthy()
})
