import type { AcmeSettings } from '@/shared/lib/api/tls-certificates'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/app/query-client'
import { ApiError } from '@/shared/lib/api/http'
import { Toaster } from '@/shared/ui/sonner'
import enCommon from '../../../../public/locales/en/common.json'

vi.mock('@/shared/lib/api/tls-certificates', () => ({
  getAcmeSettings: vi.fn(),
  updateAcmeSettings: vi.fn(),
}))

const { getAcmeSettings, updateAcmeSettings } = await import('@/shared/lib/api/tls-certificates')
const { AcmeSettingsCard } = await import('./acme-settings-card')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

const defaults: AcmeSettings = {
  configured: false,
  directory_url: 'https://acme-v02.api.letsencrypt.org/directory',
  contact_email: '',
  ca_certificate_pem: null,
  dns_provider: 'httpreq',
  dns_endpoint: '',
  dns_username: '',
  dns_password_set: false,
  dns_subdomain: '',
  propagation_delay_secs: 10,
}

function renderCard() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <I18nextProvider i18n={i18n}>
        <AcmeSettingsCard />
      </I18nextProvider>
      <Toaster />
    </QueryClientProvider>,
  )
}

describe('acmeSettingsCard', () => {
  beforeEach(() => {
    vi.mocked(getAcmeSettings).mockReset()
    vi.mocked(updateAcmeSettings).mockReset()
  })

  it('saves the httpreq settings and keeps an unchanged password', async () => {
    vi.mocked(getAcmeSettings).mockResolvedValue(defaults)
    vi.mocked(updateAcmeSettings)
      .mockRejectedValueOnce(new ApiError(400, 'the DNS provider password is required', 'the DNS provider password is required'))
      .mockResolvedValue({ ...defaults, configured: true, dns_password_set: true })
    renderCard()

    fireEvent.change(await screen.findByLabelText('Contact email'), { target: { value: 'ops@example.com' } })
    fireEvent.change(screen.getByLabelText('Provider endpoint'), { target: { value: 'https://api.dnsall.com' } })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('the DNS provider password is required')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Password / API key'), { target: { value: 'key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updateAcmeSettings).toHaveBeenLastCalledWith({
      directory_url: 'https://acme-v02.api.letsencrypt.org/directory',
      contact_email: 'ops@example.com',
      ca_certificate_pem: null,
      dns_provider: 'httpreq',
      dns_endpoint: 'https://api.dnsall.com',
      dns_username: 'me',
      dns_password: 'key',
      dns_subdomain: '',
      propagation_delay_secs: 10,
    }))
    expect(await screen.findByText('Saved')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('Password / API key').placeholder).toBe('Unchanged')
  })
})
