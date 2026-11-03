import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import { createQueryClient } from './query-client'

const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }))

beforeEach(() => toast.error.mockReset())

function ignore() {}

function failWith(message: string) {
  return async () => {
    throw new Error(message)
  }
}

it('shows every failed mutation in a toast with its reason', async () => {
  const client = createQueryClient()
  await expect(client.getMutationCache().build(client, {
    mutationFn: async () => { throw new ApiError(403, 'the code is wrong', 'the code is wrong') },
  }).execute(undefined)).rejects.toThrow()
  expect(toast.error).toHaveBeenCalledWith('the code is wrong', expect.anything())
})

it('leaves errors the mutation shows inline and expired sessions alone', async () => {
  const client = createQueryClient()
  const inline = client.getMutationCache().build(client, {
    mutationFn: async () => { throw new ApiError(401, 'wrong password', 'wrong password') },
    meta: { inlineError: (error: unknown) => error instanceof ApiError && error.status === 401 },
  })
  await expect(inline.execute(undefined)).rejects.toThrow()
  const expired = new ApiError(401, 'HTTP 401', undefined)
  expired.sessionExpired = true
  await expect(client.getMutationCache().build(client, {
    mutationFn: async () => { throw expired },
  }).execute(undefined)).rejects.toThrow()
  expect(toast.error).not.toHaveBeenCalled()
})

it('shows a query failure only while the query has no data', async () => {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  await client.fetchQuery({ queryKey: ['a'], queryFn: failWith('load failed') }).catch(ignore)
  expect(toast.error).toHaveBeenCalledWith('load failed', expect.anything())
  toast.error.mockReset()
  client.setQueryData(['b'], 1)
  await client.fetchQuery({ queryKey: ['b'], queryFn: failWith('refetch failed'), staleTime: 0 }).catch(ignore)
  expect(toast.error).not.toHaveBeenCalled()
})
