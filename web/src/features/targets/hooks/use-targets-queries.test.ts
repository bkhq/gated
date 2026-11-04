import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useCheckTargets, useMyTarget, useMyTargets, useTarget, useTargets } from './use-targets-queries'

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
    {
      name: 'web-01',
      kind: 'Ssh',
      description: '',
      group: { id: 'g1', name: 'Production' },
      status: { target_id: 't1', reachable: false, latency_ms: null, error: 'connection refused', checked_at: '2026-11-05T00:00:00Z' },
    },
    { name: 'web-02', kind: 'Ssh', description: '' },
  ]),
  checkTargets: vi.fn(async (ids: string[]) => ids.map(id => ({ target_id: id, reachable: true, checked_at: '' }))),
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

it('an admin sees only the targets granted to their roles under my targets', async () => {
  const { listUserTargets } = await import('@/shared/lib/api/targets')
  vi.mocked(listUserTargets).mockResolvedValueOnce([{ name: 'web-02', kind: 'Ssh', description: '' }] as never)
  const { result } = renderHook(() => useMyTargets(), { wrapper })
  await waitFor(() => expect(result.current.data).toBeDefined())
  expect(result.current.data?.map(t => [t.id, t.name, t.host])).toEqual([['t2', 'web-02', 'h']])
})

it('my target detail is empty for a target that is not granted', async () => {
  const { listUserTargets } = await import('@/shared/lib/api/targets')
  vi.mocked(listUserTargets).mockResolvedValueOnce([{ name: 'web-02', kind: 'Ssh', description: '' }] as never)
  const { result } = renderHook(() => useMyTarget('t1'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toBeNull()
})

it('my targets carry the last reachability check', async () => {
  for (const admin of [true, false]) {
    state.admin = admin
    const { result } = renderHook(() => useMyTargets(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.map(t => t.status)).toEqual([
      { reachable: false, latencyMs: null, error: 'connection refused', checkedAt: '2026-11-05T00:00:00Z' },
      null,
    ])
  }
})

it('checks large selections in batches of 200', async () => {
  const { checkTargets } = await import('@/shared/lib/api/targets')
  const { result } = renderHook(() => useCheckTargets(), { wrapper })
  const ids = Array.from({ length: 450 }, (_unused, i) => `t${i}`)
  const results = await result.current.mutateAsync(ids)
  expect(vi.mocked(checkTargets).mock.calls.map(([batch]) => batch.length)).toEqual([200, 200, 50])
  expect(results).toHaveLength(450)
})
