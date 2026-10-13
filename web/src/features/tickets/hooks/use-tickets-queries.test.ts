import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreateTicket, useRevokeTicket } from './use-tickets-queries'

const state = vi.hoisted(() => ({
  admin: false,
  username: 'alice',
  profileCreate: vi.fn(),
  profileRemove: vi.fn(),
  adminCreate: vi.fn(),
  adminDelete: vi.fn(),
}))

vi.mock('@/shared/hooks/use-info', () => ({
  useIsAdmin: () => state.admin,
  useInfo: () => ({ data: { username: state.username } }),
}))
vi.mock('@/shared/lib/api/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/profile')>()
  return {
    ...actual,
    profileApi: {
      ...actual.profileApi,
      tickets: { ...actual.profileApi.tickets, create: state.profileCreate, remove: state.profileRemove },
    },
  }
})
vi.mock('@/shared/lib/api/tickets', () => ({
  createAdminTicket: state.adminCreate,
  deleteAdminTicket: state.adminDelete,
  listAdminTickets: vi.fn(),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

const created = {
  ticket: { id: 't1', target: 'db-1', description: 'maintenance', uses_left: 1, expiry: null, created: '2026-09-13T00:00:00Z' },
  secret: 's3cr3t',
}

describe('self-service ticket hooks', () => {
  beforeEach(() => {
    state.admin = false
    vi.clearAllMocks()
    state.profileCreate.mockResolvedValue(created)
    state.profileRemove.mockResolvedValue(undefined)
  })

  it('creates a ticket through the profile endpoint for a non-admin', async () => {
    const { result } = renderHook(() => useCreateTicket(), { wrapper })
    const outcome = await result.current.mutateAsync({ name: 'x', scope: 'db-1', usesLimit: 1, expiresAt: '', purpose: 'maintenance' })

    expect(state.profileCreate).toHaveBeenCalledWith({ target_name: 'db-1', expiry: undefined, number_of_uses: 1, description: 'maintenance' })
    expect(state.adminCreate).not.toHaveBeenCalled()
    expect(outcome.secret).toBe('s3cr3t')
    expect(outcome.ticket.issuedBy).toBe('alice')
  })

  it('revokes the caller\'s own ticket through the profile endpoint for a non-admin', async () => {
    const { result } = renderHook(() => useRevokeTicket(), { wrapper })
    await result.current.mutateAsync('t1')
    await waitFor(() => expect(state.profileRemove).toHaveBeenCalledWith('t1'))
    expect(state.adminDelete).not.toHaveBeenCalled()
  })

  it('keeps the admin endpoint for admins', async () => {
    state.admin = true
    state.adminDelete.mockResolvedValue(undefined)
    const { result } = renderHook(() => useRevokeTicket(), { wrapper })
    await result.current.mutateAsync('t1')
    expect(state.adminDelete).toHaveBeenCalledWith('t1')
    expect(state.profileRemove).not.toHaveBeenCalled()
  })
})

it('shows remaining uses without inventing consumed totals for admin-created tickets', async () => {
  state.admin = true
  state.adminCreate.mockResolvedValue({ ...created, ticket: { ...created.ticket, username: 'bob', uses_left: 3 } })
  const { result } = renderHook(() => useCreateTicket(), { wrapper })
  const outcome = await result.current.mutateAsync({ name: 'x', scope: 'db-1', usesLimit: 3, expiresAt: '', issuedBy: 'bob' })
  expect(outcome.ticket.uses).toBe('3 left')
  expect(outcome.ticket.usedCount).toBeUndefined()
})
