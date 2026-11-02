import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as React from 'react'
import { expect, it, vi } from 'vitest'
import { AUDIT_PAGE_SIZE, useAudit } from './use-audit-queries'

const getLogs = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/api/logs', () => ({ getLogs }))

function entry(i: number) {
  return { id: `e${i}`, text: 'x', values: {}, timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, 1000 - i)).toISOString(), session_id: 's', username: 'u' }
}

it('loads older entries before the oldest loaded one', async () => {
  getLogs
    .mockResolvedValueOnce(Array.from({ length: AUDIT_PAGE_SIZE }, (_, i) => entry(i)))
    .mockResolvedValueOnce([entry(AUDIT_PAGE_SIZE)])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useAudit({ plane: 'session' }), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.hasNextPage).toBe(true)

  await act(async () => {
    await result.current.fetchNextPage()
  })
  expect(getLogs).toHaveBeenLastCalledWith(
    { limit: AUDIT_PAGE_SIZE, before: entry(AUDIT_PAGE_SIZE - 1).timestamp },
    expect.anything(),
    'session',
  )
  await waitFor(() => expect(result.current.data).toHaveLength(AUDIT_PAGE_SIZE + 1))
  expect(result.current.hasNextPage).toBe(false)
})
