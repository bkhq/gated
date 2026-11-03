import type { ListenerCertificate, TlsListener } from '@/shared/lib/api/tls-certificates'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import enCommon from '../../../../public/locales/en/common.json'

vi.mock('@/shared/lib/api/tls-certificates', () => ({
  listTlsCertificates: vi.fn(),
  generateTlsCertificate: vi.fn(),
  importTlsCertificate: vi.fn(),
  enableAcme: vi.fn(),
  disableAcme: vi.fn(),
}))

const { listTlsCertificates, generateTlsCertificate, importTlsCertificate, enableAcme, disableAcme } = await import('@/shared/lib/api/tls-certificates')
const { TlsCertificatesCard } = await import('./tls-certificates-card')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

function cert(listener: TlsListener, fingerprint: string | null, acme: ListenerCertificate['acme'] = null): ListenerCertificate {
  return {
    listener,
    acme,
    created: fingerprint ? '2026-11-02T00:00:00Z' : null,
    chain: fingerprint
      ? [{
          subject: `CN=${listener}`,
          issuer: `CN=${listener}`,
          serial: '01',
          not_before: '2026-11-02T00:00:00Z',
          not_after: '2027-11-02T00:00:00Z',
          subject_alt_names: [`${listener}.example.com`],
          sha256_fingerprint: fingerprint,
        }]
      : [],
  }
}

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <TlsCertificatesCard />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

describe('tlsCertificatesCard', () => {
  beforeEach(() => {
    vi.mocked(listTlsCertificates).mockReset()
    vi.mocked(generateTlsCertificate).mockReset()
    vi.mocked(importTlsCertificate).mockReset()
    vi.mocked(enableAcme).mockReset()
    vi.mocked(disableAcme).mockReset()
  })

  it('lists each listener and regenerates one after confirmation', async () => {
    vi.mocked(listTlsCertificates)
      .mockResolvedValueOnce([cert('http', 'AA:01'), cert('mysql', null), cert('postgres', 'CC:03')])
      .mockResolvedValue([cert('http', 'AA:02'), cert('mysql', null), cert('postgres', 'CC:03')])
    vi.mocked(generateTlsCertificate).mockResolvedValue(cert('http', 'AA:02'))
    renderCard()

    expect(await screen.findByText('AA:01')).toBeTruthy()
    expect(screen.getByText('http.example.com')).toBeTruthy()
    expect(screen.getByText(/Generated when the listener starts/)).toBeTruthy()

    const http = screen.getByRole('listitem', { name: 'HTTP proxy' })
    fireEvent.click(within(http).getByRole('button', { name: 'Regenerate' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Replace certificate' }))

    await waitFor(() => expect(generateTlsCertificate).toHaveBeenCalledWith('http'))
    expect(await screen.findByText('AA:02')).toBeTruthy()
  })

  it('imports a certificate and reports a rejected one', async () => {
    vi.mocked(listTlsCertificates).mockResolvedValue([cert('http', 'AA:01'), cert('mysql', 'BB:01'), cert('postgres', 'CC:01')])
    vi.mocked(importTlsCertificate)
      .mockRejectedValueOnce(new ApiError(400, 'invalid certificate or key: bad', 'invalid certificate or key: bad'))
      .mockResolvedValue(cert('postgres', 'CC:02'))
    renderCard()

    const postgres = await screen.findByRole('listitem', { name: 'PostgreSQL' })
    fireEvent.click(within(postgres).getByRole('button', { name: 'Import' }))
    fireEvent.change(await screen.findByLabelText('Certificate chain'), { target: { value: 'CERT' } })
    fireEvent.change(screen.getByLabelText('Private key'), { target: { value: 'KEY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import certificate' }))
    expect(await screen.findByText('invalid certificate or key: bad')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Import certificate' }))
    await waitFor(() => expect(importTlsCertificate).toHaveBeenLastCalledWith(
      'postgres',
      { certificate_pem: 'CERT', private_key_pem: 'KEY' },
    ))
    await waitFor(() => expect(screen.queryByLabelText('Certificate chain')).toBeNull())
  })

  it('requests an ACME certificate and shows the recorded error', async () => {
    const failed = cert('http', 'AA:01', { domains: ['example.com', '*.example.com'], last_error: 'publishing the challenge record failed' })
    vi.mocked(listTlsCertificates)
      .mockResolvedValueOnce([cert('admin', 'DD:01'), cert('http', 'AA:01')])
      .mockResolvedValue([cert('admin', 'DD:01'), failed])
    vi.mocked(enableAcme).mockRejectedValue(new ApiError(400, 'publishing the challenge record failed', 'publishing the challenge record failed'))
    renderCard()

    expect(await screen.findByRole('listitem', { name: 'Admin UI' })).toBeTruthy()
    const http = screen.getByRole('listitem', { name: 'HTTP proxy' })
    fireEvent.click(within(http).getByRole('button', { name: 'ACME' }))
    fireEvent.change(await screen.findByLabelText('Domains'), { target: { value: 'example.com\n*.example.com, ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request certificate' }))

    await waitFor(() => expect(enableAcme).toHaveBeenCalledWith('http', ['example.com', '*.example.com']))
    expect(await screen.findAllByText('publishing the challenge record failed')).toHaveLength(2)
    expect(screen.getByText('ACME: example.com, *.example.com')).toBeTruthy()

    vi.mocked(disableAcme).mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Stop ACME' }))
    await waitFor(() => expect(disableAcme).toHaveBeenCalledWith('http'))
  })
})
