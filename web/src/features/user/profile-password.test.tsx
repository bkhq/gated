import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { profileApi } from '@/shared/lib/api/profile'
import { PasswordDrawerBody } from './profile-auth-tab'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('submits the password and preserves errors until a successful response', async () => {
  const change = vi.spyOn(profileApi, 'changePassword').mockRejectedValueOnce(new Error('Wrong current password')).mockResolvedValueOnce(undefined)
  const close = vi.fn()
  render(<QueryClientProvider client={new QueryClient()}><PasswordDrawerBody onClose={close} /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('profile.auth.pwDrawer.current', { exact: false }), { target: { value: 'old-password' } })
  fireEvent.change(screen.getByLabelText('profile.auth.pwDrawer.new', { exact: false }), { target: { value: 'New-password123' } })
  fireEvent.change(screen.getByLabelText('profile.auth.pwDrawer.confirm', { exact: false }), { target: { value: 'New-password123' } })
  fireEvent.click(screen.getByText('actions.save'))
  await screen.findByRole('alert')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('actions.save'))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(change).toHaveBeenCalledWith({ old_password: 'old-password', password: 'New-password123' })
})
