import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/app/query-client'
import { profileApi } from '@/shared/lib/api/profile'
import { Toaster } from '@/shared/ui/sonner'
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
  render(
    <QueryClientProvider client={createQueryClient()}>
      <OtpEnrollmentDrawer onClose={close} />
      <Toaster />
    </QueryClientProvider>,
  )
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('otpEnrollment.begin'))
  await screen.findByDisplayValue('SERVERSECRET')
  expect(begin).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByLabelText('otpEnrollment.code'), { target: { value: '123456' } })
  fireEvent.click(screen.getByText('otpEnrollment.confirm'))
  expect(await screen.findByText('Invalid code')).toBeInTheDocument()
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('otpEnrollment.confirm'))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(confirm).toHaveBeenLastCalledWith({ otp: '123456' })
})

it('shows a QR code for the provisioning URI and accepts a pasted code with spaces', async () => {
  vi.spyOn(profileApi.otpDevices, 'begin').mockResolvedValue({ provisioning_uri: 'otpauth://totp/Gated:alice?secret=SERVERSECRET&issuer=Gated' })
  const confirm = vi.spyOn(profileApi.otpDevices, 'add').mockResolvedValue({ id: 'id', name: 'TOTP', added: '' })
  render(<QueryClientProvider client={createQueryClient()}><OtpEnrollmentDrawer onClose={vi.fn()} /></QueryClientProvider>)
  fireEvent.click(screen.getByText('otpEnrollment.begin'))
  expect(await screen.findByRole('img', { name: 'otpEnrollment.qr' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('otpEnrollment.code'), { target: { value: ' 123 456 ' } })
  expect(screen.getByLabelText('otpEnrollment.code')).toHaveValue('123456')
  fireEvent.click(screen.getByText('otpEnrollment.confirm'))
  await waitFor(() => expect(confirm).toHaveBeenCalledWith({ otp: '123456' }))
})
