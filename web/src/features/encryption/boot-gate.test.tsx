import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import enCommon from '../../../public/locales/en/common.json'

vi.mock('@/shared/lib/api/encryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/encryption')>()
  return { ...actual, getLockStatus: vi.fn() }
})

const { getLockStatus } = await import('@/shared/lib/api/encryption')
const { BootGate } = await import('./boot-gate')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

function renderGate() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <BootGate><div>app</div></BootGate>
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

describe('bootGate', () => {
  // After an unlock the pre-unlock listener shuts down before the full server
  // binds, so the follow-up status fetch can briefly fail to connect.
  it('recovers once a briefly unreachable gateway answers again', async () => {
    vi.mocked(getLockStatus)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ status: 'unlocked', db_ready: true })

    renderGate()

    expect(await screen.findByText('app', {}, { timeout: 5000 })).toBeTruthy()
  })

  // The pre-unlock listener reports `unlocked` before the full server (and its
  // routes and assets) is up; only the full server reports the open database.
  it('holds the app until the unlocked gateway reports its database ready', async () => {
    vi.mocked(getLockStatus)
      .mockReset()
      .mockResolvedValueOnce({ status: 'unlocked', db_ready: false })
      .mockResolvedValue({ status: 'unlocked', db_ready: true })

    renderGate()

    await waitFor(() => expect(getLockStatus).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(screen.queryByText('app')).toBeNull()
    expect(await screen.findByText('app', {}, { timeout: 5000 })).toBeTruthy()
  })
})
