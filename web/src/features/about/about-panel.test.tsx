import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'
import enCommon from '../../../public/locales/en/common.json'

vi.mock('@/shared/hooks/use-info', () => ({
  useInfo: vi.fn(() => ({
    data: {
      version: 'v0.23.0-3-gad661cd',
      external_host: 'gated.example.com',
      http_proxy_base_domain: null,
      ports: { http: 8888, ssh: 2222, mysql: null, postgres: null, kubernetes: 8443 },
    },
  })),
}))

const { AboutPanel } = await import('./about-panel')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

describe('aboutPanel', () => {
  it('shows the version as reported and each listener', () => {
    render(<I18nextProvider i18n={i18n}><AboutPanel /></I18nextProvider>)
    expect(screen.getByText('v0.23.0-3-gad661cd')).toBeTruthy()
    expect(screen.getByText('gated.example.com')).toBeTruthy()
    expect(screen.getByText('8888')).toBeTruthy()
    expect(screen.getByText('8443')).toBeTruthy()
    expect(screen.getAllByText('Disabled')).toHaveLength(2)
  })
})
