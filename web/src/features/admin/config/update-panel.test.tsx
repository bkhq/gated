import type { UpdateStatus } from '@/shared/lib/api/system'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import enCommon from '../../../../public/locales/en/common.json'

vi.mock('@/shared/lib/api/system', () => ({
  getUpdateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  applyUpdate: vi.fn(),
  restartGateway: vi.fn(),
}))

vi.mock('@/shared/lib/api/encryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/encryption')>()
  return { ...actual, getLockStatus: vi.fn(async () => ({ status: 'disabled', db_ready: true })) }
})

vi.mock('@/features/accounts/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/accounts/utils')>()
  return { ...actual, stepUpWindowOpen: vi.fn() }
})

const system = await import('@/shared/lib/api/system')
const { stepUpWindowOpen } = await import('@/features/accounts/utils')
const { UpdatePanel } = await import('./update-panel')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    supervised: true,
    instance: '1-a',
    current: '0.23.0',
    last_good: '0.23.0',
    available: null,
    status: 'running',
    last_check: null,
    last_error: null,
    checked_nonce: 0,
    check_error: null,
    ...patch,
  }
}

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <UpdatePanel />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

describe('updatePanel', () => {
  beforeEach(() => {
    vi.mocked(system.getUpdateStatus).mockReset()
    vi.mocked(system.checkForUpdate).mockReset()
    vi.mocked(system.restartGateway).mockReset()
    vi.mocked(system.applyUpdate).mockReset()
  })

  it('explains that actions need lode when the gateway is not supervised', async () => {
    vi.mocked(system.getUpdateStatus).mockResolvedValue({ ...status(), supervised: false })
    renderPanel()
    expect(await screen.findByText(/not running under lode/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restart gateway' })).toBeNull()
  })

  it('reports a found version after lode answers the check', async () => {
    vi.mocked(system.getUpdateStatus)
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ available: '0.24.0', checked_nonce: 1 }))
    vi.mocked(system.checkForUpdate).mockResolvedValue(1)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))

    expect(await screen.findByText('Version 0.24.0 is available.')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Update to 0.24.0' })).toBeTruthy()
  })

  it('restarts after a plain confirmation while the step-up window is open', async () => {
    vi.mocked(system.getUpdateStatus).mockResolvedValue(status())
    vi.mocked(stepUpWindowOpen).mockResolvedValue(true)
    vi.mocked(system.restartGateway).mockResolvedValue()
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Restart gateway' }))
    expect(await screen.findByText('Restart the gateway?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(system.restartGateway).toHaveBeenCalledWith({}))
    expect(await screen.findByText(/Restarting; the page reloads/)).toBeTruthy()
  })

  it('asks for a password before updating when the step-up window is closed', async () => {
    vi.mocked(system.getUpdateStatus).mockResolvedValue(status({ available: '0.24.0' }))
    vi.mocked(stepUpWindowOpen).mockResolvedValue(false)
    vi.mocked(system.applyUpdate).mockResolvedValue()
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.24.0' }))
    fireEvent.change(await screen.findByLabelText(/password/i), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(system.applyUpdate).toHaveBeenCalledWith({ version: '0.24.0', password: 'pw' }))
  })
})
