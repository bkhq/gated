import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/app/query-client'
import enCommon from '../../../../public/locales/en/common.json'

vi.mock('@/shared/lib/api/login-protection', () => ({
  listIpBlocks: vi.fn(),
  liftIpBlock: vi.fn(),
  listUserLockouts: vi.fn(),
  liftUserLockout: vi.fn(),
}))

const api = await import('@/shared/lib/api/login-protection')
const { LoginProtectionCard } = await import('./login-protection-card')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

function renderCard() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <I18nextProvider i18n={i18n}>
        <LoginProtectionCard />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

describe('login protection card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says so when nothing is blocked or locked', async () => {
    vi.mocked(api.listIpBlocks).mockResolvedValue([])
    vi.mocked(api.listUserLockouts).mockResolvedValue([])
    renderCard()
    expect(await screen.findByText('No address is blocked.')).toBeInTheDocument()
    expect(screen.getByText('No user is locked out.')).toBeInTheDocument()
  })

  it('lists blocks and lockouts and lifts them', async () => {
    vi.mocked(api.listIpBlocks).mockResolvedValue([
      { ip_address: '10.0.0.7', block_count: 2, blocked_at: '2026-11-12T10:00:00Z', expires_at: '2026-11-12T11:00:00Z' },
    ])
    vi.mocked(api.listUserLockouts).mockResolvedValue([
      { username: 'alice', locked_at: '2026-11-12T10:00:00Z', expires_at: null },
    ])
    vi.mocked(api.liftIpBlock).mockResolvedValue(undefined)
    vi.mocked(api.liftUserLockout).mockResolvedValue(undefined)
    renderCard()

    expect(await screen.findByText('10.0.0.7')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('Until lifted')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Unblock 10.0.0.7' }))
    await waitFor(() => expect(api.liftIpBlock).toHaveBeenCalledWith('10.0.0.7'))
    fireEvent.click(screen.getByRole('button', { name: 'Unlock alice' }))
    await waitFor(() => expect(api.liftUserLockout).toHaveBeenCalledWith('alice'))
    await waitFor(() => expect(api.listIpBlocks).toHaveBeenCalledTimes(3))
  })
})
