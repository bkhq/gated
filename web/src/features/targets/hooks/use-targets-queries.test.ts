import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useTarget, useTargets } from './use-targets-queries'

const state = vi.hoisted(() => ({ admin: true }))

function adminTarget(id: string, name: string, groupId?: string) {
  return {
    id,
    name,
    description: '',
    group_id: groupId,
    options: { kind: 'Ssh', host: 'h', port: 22, username: 'u', auth: { kind: 'Password', password: '' } },
  }
}

vi.mock('@/shared/hooks/use-info', () => ({ useIsAdmin: () => state.admin }))
vi.mock('@/shared/lib/api/target-groups', () => ({
  listTargetGroups: vi.fn(async () => [{ id: 'g1', name: 'Production', description: '' }]),
}))
vi.mock('@/shared/lib/api/targets', () => ({
  listAdminTargets: vi.fn(async () => [adminTarget('t1', 'web-01', 'g1'), adminTarget('t2', 'web-02')]),
  getAdminTarget: vi.fn(async () => adminTarget('t1', 'web-01', 'g1')),
  listUserTargets: vi.fn(async () => [
    { name: 'web-01', kind: 'Ssh', description: '', group: { id: 'g1', name: 'Production' } },
    { name: 'web-02', kind: 'Ssh', description: '' },
  ]),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

beforeEach(() => {
  state.admin = true
})

it('admin targets carry the group id and its resolved name', async () => {
  const { result } = renderHook(() => useTargets(), { wrapper })
  await waitFor(() => expect(result.current.data).toBeDefined())
  expect(result.current.data?.map(t => [t.group, t.groupName])).toEqual([['g1', 'Production'], ['', '']])
})

it('admin target detail resolves the group name', async () => {
  const { result } = renderHook(() => useTarget('t1'), { wrapper })
  await waitFor(() => expect(result.current.data).toBeTruthy())
  expect(result.current.data).toMatchObject({ group: 'g1', groupName: 'Production' })
})

it('user targets use the same id/name shape', async () => {
  state.admin = false
  const { result } = renderHook(() => useTargets(), { wrapper })
  await waitFor(() => expect(result.current.data).toBeDefined())
  expect(result.current.data?.map(t => [t.group, t.groupName])).toEqual([['g1', 'Production'], ['', '']])
})
