import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import enCommon from '../../../public/locales/en/common.json'

vi.mock('@/shared/hooks/use-lock-status', () => ({
  invalidateLockStatus: vi.fn(async () => {}),
  setLockStatusUnlocked: vi.fn(),
}))

vi.mock('@/shared/lib/api/encryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/encryption')>()
  return { ...actual, unlockEncryption: vi.fn() }
})

const { unlockEncryption } = await import('@/shared/lib/api/encryption')
const { UnlockPage } = await import('./unlock-page')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

describe('unlockPage', () => {
  it('reminds of the minimum master password length when the password is wrong', async () => {
    vi.mocked(unlockEncryption).mockRejectedValue(new ApiError(401, 'Unauthorized', null))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <UnlockPage />
        </I18nextProvider>
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'pässwörd-密码' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByText('Master password is incorrect. It is at least 12 characters long.')).toBeTruthy()
  })
})
