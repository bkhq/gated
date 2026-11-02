import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import enCommon from '../../../public/locales/en/common.json'

vi.mock('@/shared/lib/api/setup', () => ({
  getSetupStatus: vi.fn(),
  initSetup: vi.fn(),
}))

const { getSetupStatus, initSetup } = await import('@/shared/lib/api/setup')
const { rememberBootstrapToken } = await import('./bootstrap-token')
const { SetupGate } = await import('./setup-gate')

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
        <SetupGate><div>app</div></SetupGate>
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

function fillForm(token: string | null) {
  if (token !== null)
    fireEvent.change(screen.getByLabelText('Bootstrap token'), { target: { value: token } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'secret-pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
}

describe('setupGate', () => {
  beforeEach(() => {
    vi.mocked(getSetupStatus).mockReset()
    vi.mocked(initSetup).mockReset()
  })

  it('renders the app once setup is complete', async () => {
    vi.mocked(getSetupStatus).mockResolvedValue({ needs_setup: false })
    renderGate()
    expect(await screen.findByText('app')).toBeTruthy()
  })

  it('registers the first admin, then shows the app', async () => {
    vi.mocked(getSetupStatus)
      .mockResolvedValueOnce({ needs_setup: true })
      .mockResolvedValue({ needs_setup: false })
    vi.mocked(initSetup).mockResolvedValue()
    renderGate()

    await screen.findByText('Create the admin account')
    expect(screen.queryByText('app')).toBeNull()
    fillForm(' token ')

    await waitFor(() => expect(initSetup).toHaveBeenCalledWith(
      { bootstrap_token: 'token', username: 'admin', password: 'secret-pass' },
    ))
    expect(await screen.findByText('app')).toBeTruthy()
  })

  it('reuses the token entered during encryption setup', async () => {
    vi.mocked(getSetupStatus).mockResolvedValue({ needs_setup: true })
    vi.mocked(initSetup).mockResolvedValue()
    rememberBootstrapToken('from-encryption')
    renderGate()

    await screen.findByText('Create the admin account')
    expect(screen.getByLabelText<HTMLInputElement>('Bootstrap token').value).toBe('from-encryption')
    fillForm(null)
    await waitFor(() => expect(initSetup).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrap_token: 'from-encryption' }),
    ))
  })

  it('reports a rejected token', async () => {
    vi.mocked(getSetupStatus).mockResolvedValue({ needs_setup: true })
    vi.mocked(initSetup).mockRejectedValue(new ApiError(403, 'Forbidden', { code: 'forbidden' }))
    renderGate()

    await screen.findByText('Create the admin account')
    fillForm('wrong')
    expect(await screen.findByText('Bootstrap token is invalid or already used.')).toBeTruthy()
  })
})
