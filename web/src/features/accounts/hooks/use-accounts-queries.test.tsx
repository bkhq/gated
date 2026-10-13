import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRevealAccountSecret } from './use-accounts-queries'

const reveal = vi.hoisted(() => vi.fn())
vi.mock('@/shared/lib/api/accounts', async original => ({ ...await original<typeof import('@/shared/lib/api/accounts')>(), revealAdminAccount: reveal }))
afterEach(cleanup)

it('sends fresh confirmation, then discards a late response after reset', async () => {
  let complete!: (value: unknown) => void
  reveal.mockReturnValue(new Promise((resolve) => {
    complete = resolve
  }))
  const { result } = renderHook(() => useRevealAccountSecret())
  let pending!: Promise<void>
  act(() => {
    pending = result.current.mutateAsync({ id: '1', confirmation: { password: 'confirmation', reason: 'maintenance' } })
  })
  expect(reveal).toHaveBeenCalledWith(1, { password: 'confirmation', reason: 'maintenance' }, expect.any(AbortSignal))
  act(() => result.current.reset())
  expect(reveal.mock.calls.at(-1)?.[2].aborted).toBe(true)
  await act(async () => {
    complete({ credentials: { kind: 'ssh-password', username: 'root', password: 'secret' } })
    await pending
  })
  expect(result.current.data).toBeNull()
})

it('clears revealed values on hide without a shared query cache', async () => {
  reveal.mockResolvedValue({ credentials: { kind: 'ssh-password', username: 'root', password: 'secret' } })
  const { result } = renderHook(() => useRevealAccountSecret())
  await act(async () => result.current.mutateAsync({ id: '1', confirmation: { otp: '123456', reason: 'maintenance' } }))
  await waitFor(() => expect(result.current.data?.credentials.kind).toBe('ssh-password'))
  act(() => result.current.reset())
  expect(result.current.data).toBeNull()
})
