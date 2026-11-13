import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userApi } from '@/shared/lib/api/http'
import { profileApi } from '@/shared/lib/api/profile'
import { MfaSetupPage } from './mfa-setup-page'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  navigate.mockReset()
})

function view(client: QueryClient) {
  return <QueryClientProvider client={client}><MfaSetupPage /></QueryClientProvider>
}

it('reloads the instance info once the device is enrolled', async () => {
  vi.spyOn(profileApi.otpDevices, 'begin').mockResolvedValue({ provisioning_uri: 'otpauth://totp/Gated?secret=SERVERSECRET' })
  vi.spyOn(profileApi.otpDevices, 'add').mockResolvedValue({ id: 'id', name: 'TOTP', added: '' })
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  render(view(client))
  expect(screen.getByText('mfaSetup.title')).toBeInTheDocument()
  fireEvent.click(screen.getByText('otpEnrollment.begin'))
  await screen.findByDisplayValue('SERVERSECRET')
  fireEvent.change(screen.getByLabelText('otpEnrollment.code'), { target: { value: '123456' } })
  fireEvent.click(screen.getByText('otpEnrollment.confirm'))
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['info'] }))
})

it('offers signing out instead of cancelling', async () => {
  const post = vi.spyOn(userApi, 'post').mockResolvedValue(undefined)
  render(view(new QueryClient()))
  fireEvent.click(screen.getByText('actions.signOut'))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/auth/login' }))
  expect(post).toHaveBeenCalledWith('/auth/logout', undefined, undefined)
})
