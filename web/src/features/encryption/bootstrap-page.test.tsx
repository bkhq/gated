import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import enCommon from '../../../public/locales/en/common.json'

vi.mock('@/shared/hooks/use-lock-status', () => ({
  invalidateLockStatus: vi.fn(async () => {}),
  setLockStatusUnlocked: vi.fn(),
}))

vi.mock('@/shared/lib/api/encryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/encryption')>()
  return { ...actual, initEncryption: vi.fn() }
})

const { setLockStatusUnlocked } = await import('@/shared/hooks/use-lock-status')
const { initEncryption } = await import('@/shared/lib/api/encryption')
const { BootstrapPage } = await import('./bootstrap-page')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

function submitForm() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <BootstrapPage />
      </I18nextProvider>
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText('Bootstrap token'), { target: { value: 'token' } })
  fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'correct-horse-battery' } })
  fireEvent.change(screen.getByLabelText('Confirm master password'), { target: { value: 'correct-horse-battery' } })
  fireEvent.click(screen.getByRole('button', { name: 'Initialize' }))
}

describe('bootstrapPage', () => {
  beforeEach(() => {
    vi.mocked(setLockStatusUnlocked).mockClear()
  })

  it('requires acknowledging a retained plaintext backup before continuing', async () => {
    vi.mocked(initEncryption).mockResolvedValue({ status: 'unlocked', plaintext_backup: '/data/db.sqlite3.plain.bak' })
    submitForm()
    expect(await screen.findByText('/data/db.sqlite3.plain.bak')).toBeTruthy()
    expect(setLockStatusUnlocked).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' }))
    await waitFor(() => expect(setLockStatusUnlocked).toHaveBeenCalled())
  })

  it('continues immediately when no plaintext backup was kept', async () => {
    vi.mocked(initEncryption).mockResolvedValue({ status: 'unlocked', plaintext_backup: null })
    submitForm()
    await waitFor(() => expect(setLockStatusUnlocked).toHaveBeenCalled())
  })
})
