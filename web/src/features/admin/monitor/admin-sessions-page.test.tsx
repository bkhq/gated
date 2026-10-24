import type { LiveSession } from '@/shared/types/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, expect, it, vi } from 'vitest'
import zhCommon from '../../../../public/locales/zh-CN/common.json'
import { AdminSessionsPage } from './admin-sessions-page'

const state = vi.hoisted(() => ({
  live: [] as LiveSession[],
  past: { items: [] as LiveSession[], total: 0 },
  pastQuery: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/shared/components/stat-card', () => ({
  StatCard: ({ label, hint }: { label: string, hint?: string }) => (
    <div data-testid="stat-card">
      <span>{label}</span>
      <span>{hint}</span>
    </div>
  ),
}))
vi.mock('@/features/sessions/hooks/use-sessions-stream', () => ({ useSessionsStream: () => {} }))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
  return {
    useLiveSessions: () => ({ data: state.live, isLoading: false }),
    usePastSessions: (query: unknown) => {
      state.pastQuery(query)
      return { data: state.past, isLoading: false }
    },
    useManagementSessions: () => ({ data: [], isLoading: false }),
    useForceCloseSessions: () => mutation,
    useDeleteSessions: () => mutation,
    useClearSessionHistory: () => mutation,
    useRevokeManagementSession: () => mutation,
  }
})

await i18n.use(initReactI18next).init({
  lng: 'zh-CN',
  resources: { 'zh-CN': { common: zhCommon } },
  defaultNS: 'common',
  interpolation: { escapeValue: false },
})

afterEach(cleanup)

function session(id: string, protocol: string): LiveSession {
  return { id, user: 'alice', target: 'db-01', protocol, started: '', duration: '', state: 'live' }
}

function renderPage(live: LiveSession[]) {
  state.live = live
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <AdminSessionsPage />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

it('counts live sessions by real protocol', () => {
  renderPage([
    session('a', 'ssh'),
    session('b', 'mysql'),
    session('c', 'postgres'),
    session('d', 'web-sftp'),
  ])
  expect(screen.getByText('1 SSH · 2 DB · 1 其他')).toBeTruthy()
})

it('does not count an sftp session as DB and hides other when zero', () => {
  renderPage([session('a', 'sftp')])
  expect(screen.getByText('0 SSH · 0 DB · 1 其他')).toBeTruthy()
  cleanup()
  renderPage([session('a', 'ssh'), session('b', 'pg')])
  expect(screen.getByText('1 SSH · 1 DB')).toBeTruthy()
})

it('localizes the relative last-updated time', () => {
  renderPage([])
  expect(screen.getByText(`更新于 ${zhCommon.monitor.sessions.relative.justNow}`)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/just now|\d+[sm] ago/)
})

it('renders only the live sessions stat card', () => {
  renderPage([session('a', 'ssh')])
  const cards = screen.getAllByTestId('stat-card')
  expect(cards).toHaveLength(1)
  expect(cards[0]?.textContent).toContain(zhCommon.monitor.sessions.stats.liveNow)
})

it('pages past sessions on the server', () => {
  state.past = {
    items: Array.from({ length: 50 }, (_, i) => ({ ...session(`p${i}`, 'ssh'), state: 'closed' as const })),
    total: 120,
  }
  renderPage([])
  fireEvent.click(screen.getByRole('tab', { name: /历史/ }))
  expect(screen.getByText('第 1–50 条，共 120 条')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /下一页/ }))
  expect(state.pastQuery).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 50 }))
  state.past = { items: [], total: 0 }
})
