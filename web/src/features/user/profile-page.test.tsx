import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { ProfilePage } from './profile-page'

const { changeLanguage } = vi.hoisted(() => ({ changeLanguage: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage } }) }))
vi.mock('@/shared/ui/select', () => ({ Select: ({ id, value, onValueChange, options }: { id: string, value: string, onValueChange: (value: string) => void, options: { value: string, label: string }[] }) => <select id={id} value={value} onChange={event => onValueChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/shared/hooks/use-info', () => ({
  useIsAdmin: () => false,
  useInfo: () => ({ data: { session_lifetime: 1800, session_lifetime_options: [1800, 14400] } }),
}))
const { setSessionLifetime } = vi.hoisted(() => ({ setSessionLifetime: vi.fn(async () => {}) }))
vi.mock('@/shared/lib/api/auth', () => ({ setSessionLifetime }))
afterEach(cleanup)

it('keeps server identity read-only and describes the local preference scope', () => {
  useAppStore.getState().updateIdentity({ name: 'alice', username: 'alice', role: 'User' })
  render(<QueryClientProvider client={new QueryClient()}><ProfilePage /></QueryClientProvider>)
  expect(screen.getByLabelText(/profile.info.displayName/)).toHaveProperty('readOnly', true)
  expect(screen.queryByRole('button', { name: 'actions.save' })).toBeNull()
  expect(screen.getByText('profile.info.localPreferencesHint')).toBeTruthy()
})

it('applies the selected language to the translation engine', () => {
  render(<QueryClientProvider client={new QueryClient()}><ProfilePage /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('profile.info.language'), { target: { value: 'en' } })
  expect(changeLanguage).toHaveBeenCalledWith('en')
})

it('changes the lifetime of the current session', async () => {
  render(<QueryClientProvider client={new QueryClient()}><ProfilePage /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('profile.info.sessionLifetime'), { target: { value: '14400' } })
  await waitFor(() => expect(setSessionLifetime).toHaveBeenCalledWith(14400))
  expect(localStorage.getItem('gated.sessionLifetime')).toBe('14400')
})
