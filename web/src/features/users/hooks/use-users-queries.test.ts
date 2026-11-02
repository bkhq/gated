import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useUsers } from './use-users-queries'

const state = vi.hoisted(() => ({ listUsers: vi.fn() }))

vi.mock('@/shared/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/users')>()
  return { ...actual, listAdminUsers: state.listUsers }
})

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

describe('useUsers', () => {
  it('maps role names from the list response so the role filter can match', async () => {
    state.listUsers.mockResolvedValue([
      { id: 'u1', username: 'alice', description: '', roles: ['admin', 'ops'] },
      { id: 'u2', username: 'bob', description: '', roles: ['ops'] },
      { id: 'u3', username: 'carol', description: '', roles: [] },
    ])

    const { result } = renderHook(() => useUsers(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const users = result.current.data ?? []
    expect(users.map(user => user.roles)).toEqual([['admin', 'ops'], ['ops'], []])
    // Same predicate as the users page role filter.
    expect(users.filter(user => user.roles.includes('admin')).map(user => user.username)).toEqual(['alice'])
    expect(users.filter(user => user.roles.includes('ops')).map(user => user.username)).toEqual(['alice', 'bob'])
  })
})
