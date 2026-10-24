import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { profileApi } from '@/shared/lib/api/profile'
import { OtpEnrollmentDrawer } from './otp-enrollment-drawer'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('waits for server enrollment and valid proof before closing', async () => {
  const begin = vi.spyOn(profileApi.otpDevices, 'begin').mockResolvedValue({ provisioning_uri: 'otpauth://totp/Gated?secret=SERVERSECRET' })
  const confirm = vi.spyOn(profileApi.otpDevices, 'add').mockRejectedValueOnce(new Error('Invalid code')).mockResolvedValueOnce({ id: 'id', name: 'TOTP', added: '' })
  const close = vi.fn()
  render(<QueryClientProvider client={new QueryClient()}><OtpEnrollmentDrawer onClose={close} /></QueryClientProvider>)
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('otpEnrollment.begin'))
  await screen.findByDisplayValue('SERVERSECRET')
  expect(begin).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByLabelText('otpEnrollment.code'), { target: { value: '123456' } })
  fireEvent.click(screen.getByText('otpEnrollment.confirm'))
  await screen.findByRole('alert')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('otpEnrollment.confirm'))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(confirm).toHaveBeenLastCalledWith({ otp: '123456' })
})
