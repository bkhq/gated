import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TicketFormDialog } from './ticket-form-dialog'

vi.mock('@/features/targets/hooks/use-targets-queries', () => ({ useTargets: () => ({ data: [], isPending: false }) }))
vi.mock('@/shared/hooks/use-info', () => ({ useIsAdmin: () => true, useInfo: () => ({ data: { username: 'admin' } }) }))
afterEach(cleanup)

it('shows existing tickets without an unsupported Save action', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TicketFormDialog open mode="edit" onClose={vi.fn()} ticket={{ id: 'ticket', name: 'Maintenance', scope: 'server', usesLeft: 3, usesLimit: 3, expiresIn: '1h', expiresAt: '2099-01-01T00:00:00Z', issuedBy: 'admin', issuedAt: '', purpose: '', state: 'active' }} />
    </QueryClientProvider>,
  )
  expect(screen.queryByRole('button', { name: 'actions.save' })).toBeNull()
  expect(screen.getByDisplayValue('Maintenance')).toBeDisabled()
})

it('lets a new ticket have unlimited uses', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TicketFormDialog open mode="create" ticket={null} onClose={vi.fn()} />
    </QueryClientProvider>,
  )
  const uses = screen.getByLabelText('tickets.form.usesLabel')
  expect(uses).toHaveValue(1)
  fireEvent.click(screen.getByRole('checkbox', { name: 'tickets.form.usesUnlimited' }))
  expect(uses).toBeDisabled()
  expect(uses).toHaveValue(null)
  expect(screen.queryByText('tickets.errors.usesInvalid')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'tickets.form.usesUnlimited' }))
  expect(uses).toHaveValue(1)
})
