import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userApi } from '@/shared/lib/api/http'
import { formatCountdown } from './format-countdown'
import { SessionCountdown } from './session-countdown'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { time?: string }) => options?.time ? `${key}:${options.time}` : key }),
}))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}><SessionCountdown /></QueryClientProvider>
}

it('formats the time left', () => {
  expect(formatCountdown(0)).toBe('00:00')
  expect(formatCountdown(59)).toBe('00:59')
  expect(formatCountdown(1799)).toBe('29:59')
  expect(formatCountdown(3600)).toBe('1:00:00')
  expect(formatCountdown(4 * 3600 + 61)).toBe('4:01:01')
  expect(formatCountdown(-5)).toBe('00:00')
})

it('shows the time the gateway reports and counts down', async () => {
  const get = vi.spyOn(userApi, 'get').mockResolvedValue({ expires_in: 1800 })
  render(view())
  expect(await screen.findByText('menu.sessionExpiresIn:30:00')).toBeInTheDocument()
  expect(get).toHaveBeenCalledWith('/auth/session', expect.anything())

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(screen.getByText('menu.sessionExpiresIn:29:57')).toBeInTheDocument()
  // Counting down asks the gateway nothing further.
  expect(get).toHaveBeenCalledTimes(1)
})

it('shows nothing until the gateway answered', () => {
  vi.spyOn(userApi, 'get').mockReturnValue(new Promise(() => {}))
  const { container } = render(view())
  expect(container).toBeEmptyDOMElement()
})
