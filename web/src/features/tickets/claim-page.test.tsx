import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import { ClaimPage } from './claim-page'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/shared/hooks/use-site-title', () => ({ useSiteTitle: () => 'Gated' }))
const claimTicket = vi.fn()
vi.mock('@/shared/lib/api/tickets', () => ({ claimTicket: (secret: string) => claimTicket(secret) }))

const assign = vi.fn()
const replaceState = vi.fn()
const originalLocation = window.location

beforeEach(() => {
  claimTicket.mockReset()
  assign.mockReset()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign, hash: '#s3%20cret', pathname: '/ui/ticket' } })
  vi.spyOn(window.history, 'replaceState').mockImplementation(replaceState)
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  vi.restoreAllMocks()
})

it('claims the secret from the fragment, drops it from the URL and opens the target', async () => {
  claimTicket.mockResolvedValue({ target_name: 'web-01', kind: 'Ssh' })
  render(<ClaimPage />)
  expect(screen.getByRole('status')).toHaveTextContent('tickets.claim.connecting')
  await waitFor(() => expect(assign).toHaveBeenCalledWith('/ui/terminal/ssh/web-01'))
  expect(claimTicket).toHaveBeenCalledWith('s3 cret')
  expect(replaceState).toHaveBeenCalledWith(null, '', '/ui/ticket')
})

it('tells a recipient whose ticket is gone, without sending them to the login page', async () => {
  claimTicket.mockRejectedValue(new ApiError(404, 'HTTP 404', null))
  render(<ClaimPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent('tickets.claim.invalid')
  expect(assign).not.toHaveBeenCalled()
})

it('reports a link without a secret', async () => {
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign, hash: '', pathname: '/ui/ticket' } })
  render(<ClaimPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent('tickets.claim.missing')
  expect(claimTicket).not.toHaveBeenCalled()
})
