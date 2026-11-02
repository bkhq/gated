import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useRoles } from './use-roles-queries'

const state = vi.hoisted(() => ({ listRoles: vi.fn() }))

vi.mock('@/shared/lib/api/roles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/roles')>()
  return { ...actual, listAdminRoles: state.listRoles }
})

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

describe('useRoles', () => {
  it('maps the builtin flag from the API', async () => {
    state.listRoles.mockResolvedValue([
      { id: 'r1', name: 'admin', description: '', allow_file_transfer: true, builtin: true },
      { id: 'r2', name: 'ops', description: '', allow_file_transfer: false, builtin: false },
    ])

    const { result } = renderHook(() => useRoles(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.map(role => [role.name, role.builtin])).toEqual([['admin', true], ['ops', false]])
  })
})
