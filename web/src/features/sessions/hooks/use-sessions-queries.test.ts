import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { expect, it, vi } from 'vitest'
import { useLiveSessions, usePastSessions } from './use-sessions-queries'

const listSessions = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ items: [] as never[], offset: 0, total: 0 })))

vi.mock('@/shared/lib/api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/sessions')>()
  return { ...actual, listSessions }
})

it('leaves out connections that never authenticated', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useLiveSessions(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ logged_in_only: true }), expect.anything())
})

it('pages closed sessions on the server with the given filters', async () => {
  listSessions.mockResolvedValueOnce({ items: [], offset: 50, total: 120 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(
    () => usePastSessions({ offset: 50, limit: 50, protocol: 'ssh', search: 'web', targetId: 't1' }),
    { wrapper },
  )
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.total).toBe(120)
  expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({
    closed_only: true,
    offset: 50,
    limit: 50,
    protocol: 'ssh',
    search: 'web',
    target_id: 't1',
  }), expect.anything())
})
