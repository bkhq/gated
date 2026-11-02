import { fireEvent, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { expect, it, vi } from 'vitest'
import enCommon from '../../../public/locales/en/common.json'
import { RouteError } from './route-error'

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode, to: string }) => <a href={to}>{children}</a>,
  useRouter: () => ({ invalidate }),
}))

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

it('renders the localized title, the error message and a retry action', () => {
  const reset = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <RouteError error={new Error('boom')} reset={reset} />
    </I18nextProvider>,
  )
  expect(screen.getByText(enCommon.states.routeError.title)).toBeInTheDocument()
  expect(screen.getByText('boom')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: enCommon.states.routeError.home })).toHaveAttribute('href', '/')
  fireEvent.click(screen.getByRole('button', { name: enCommon.states.routeError.retry }))
  expect(reset).toHaveBeenCalled()
  expect(invalidate).toHaveBeenCalled()
})
