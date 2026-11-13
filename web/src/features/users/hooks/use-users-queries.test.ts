import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useUpdateUser, useUsers } from './use-users-queries'

const state = vi.hoisted(() => ({ listUsers: vi.fn(), getUser: vi.fn(), updateUser: vi.fn(), getRoles: vi.fn(), addRole: vi.fn(), deleteRole: vi.fn(), setExpiry: vi.fn() }))

vi.mock('@/shared/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/users')>()
  return { ...actual, listAdminUsers: state.listUsers, getAdminUser: state.getUser, updateAdminUser: state.updateUser, getAdminUserRoles: state.getRoles, addUserRole: state.addRole, deleteUserRole: state.deleteRole, setUserRoleExpiry: state.setExpiry }
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

describe('useUpdateUser', () => {
  const stored = { id: 'u1', username: 'alice', description: 'Alice', allowed_ip_ranges: ['10.0.0.0/8'] }

  it('keeps the allowed address ranges when a save does not touch them', async () => {
    state.getUser.mockResolvedValue(stored)
    state.updateUser.mockImplementation(async (_id: string, body: object) => ({ ...stored, ...body }))
    const { result } = renderHook(() => useUpdateUser(), { wrapper })

    const saved = await result.current.mutateAsync({ id: 'u1', patch: { name: 'Alice A.' } })
    expect(state.updateUser).toHaveBeenLastCalledWith('u1', expect.objectContaining({ allowed_ip_ranges: ['10.0.0.0/8'] }))
    expect(saved?.allowed_ip_ranges).toEqual(['10.0.0.0/8'])
  })

  it('sends changed ranges and clears them with an empty list', async () => {
    state.getUser.mockResolvedValue(stored)
    state.updateUser.mockImplementation(async (_id: string, body: object) => ({ ...stored, ...body }))
    const { result } = renderHook(() => useUpdateUser(), { wrapper })

    await result.current.mutateAsync({ id: 'u1', patch: { allowed_ip_ranges: ['192.168.0.0/16', '::1'] } })
    expect(state.updateUser).toHaveBeenLastCalledWith('u1', expect.objectContaining({ allowed_ip_ranges: ['192.168.0.0/16', '::1'] }))
    await result.current.mutateAsync({ id: 'u1', patch: { allowed_ip_ranges: [] } })
    expect(state.updateUser).toHaveBeenLastCalledWith('u1', expect.objectContaining({ allowed_ip_ranges: [] }))
  })

  it('sends only the role expiries that changed', async () => {
    state.getUser.mockResolvedValue(stored)
    state.updateUser.mockResolvedValue(stored)
    state.getRoles.mockResolvedValue([
      { id: 'kept', name: 'kept', expires_at: '2030-01-01T00:00:00Z' },
      { id: 'moved', name: 'moved', expires_at: '2030-01-01T00:00:00Z' },
      { id: 'cleared', name: 'cleared', expires_at: '2030-01-01T00:00:00Z' },
      { id: 'removed', name: 'removed', expires_at: null },
    ])
    const { result } = renderHook(() => useUpdateUser(), { wrapper })
    await result.current.mutateAsync({
      id: 'u1',
      patch: {},
      roleIds: ['kept', 'moved', 'cleared', 'added'],
      // Same instant as stored, written with another offset.
      roleExpiry: { kept: '2030-01-01T01:00:00+01:00', moved: '2031-01-01T00:00:00Z', cleared: null, added: '2032-01-01T00:00:00Z' },
    })
    expect(state.addRole).toHaveBeenCalledWith('u1', 'added')
    expect(state.deleteRole).toHaveBeenCalledWith('u1', 'removed')
    expect(state.setExpiry.mock.calls).toEqual([
      ['u1', 'moved', '2031-01-01T00:00:00Z'],
      ['u1', 'cleared', null],
      ['u1', 'added', '2032-01-01T00:00:00Z'],
    ])
  })
})
