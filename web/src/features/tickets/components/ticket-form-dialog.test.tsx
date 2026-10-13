import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TicketFormDialog } from './ticket-form-dialog'

vi.mock('@/features/targets/hooks/use-targets-queries', () => ({ useTargets: () => ({ data: [], isPending: false }) }))
vi.mock('@/shared/hooks/use-info', () => ({ useIsAdmin: () => true, useInfo: () => ({ data: { username: 'admin' } }) }))
afterEach(cleanup)

it('shows existing tickets without an unsupported Save action', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TicketFormDialog open mode="edit" onClose={vi.fn()} ticket={{ id: 'ticket', name: 'Maintenance', scope: 'server', uses: '3 left', usesLimit: 3, expiresIn: '1h', expiresAt: '2099-01-01T00:00:00Z', issuedBy: 'admin', issuedAt: '', purpose: '', state: 'active' }} />
    </QueryClientProvider>,
  )
  expect(screen.queryByRole('button', { name: 'actions.save' })).toBeNull()
  expect(screen.getByDisplayValue('Maintenance')).toBeDisabled()
})
