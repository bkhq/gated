import type { RecentActivityEntry } from '@/shared/types/domain'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OverviewPage } from './overview-page'

const empty = { data: [], isLoading: false }
const { recent } = vi.hoisted(() => ({ recent: { current: [] as RecentActivityEntry[] } }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.count === undefined ? key : `${key}:${String(opts.count)}`),
    i18n: { language: 'en' },
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, className }: { to: string, children: React.ReactNode, className?: string }) => <a href={to} className={className}>{children}</a>,
}))
vi.mock('@/features/auth-requests/hooks/use-auth-requests-queries', () => ({ useAuthRequests: () => empty }))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({ useMyLiveSessions: () => empty }))
vi.mock('@/features/targets/hooks/use-targets-queries', () => ({ useTargets: () => empty, useFrequentTargets: () => empty }))
vi.mock('@/features/tickets/hooks/use-tickets-queries', () => ({ useMyTickets: () => empty }))
vi.mock('@/features/recent-activity/hooks/use-recent-activity-queries', () => ({
  useRecentActivity: () => ({ data: recent.current, isLoading: false }),
}))

afterEach(cleanup)

it('renders one human-labelled row per aggregated session with a view-all link', () => {
  recent.current = [{
    id: '30d76c6b-442e-41be-b969-7b2668593890',
    sessionId: '30d76c6b-442e-41be-b969-7b2668593890',
    user: 'admin',
    target: 'test-ssh',
    latest: '2026-10-21T02:49:54.025151399Z',
    events: [
      { key: 'events.targetConnected', count: 1 },
      { key: 'events.fileOperation', count: 12 },
    ],
  }]
  render(<OverviewPage />)

  const rows = screen.getAllByTestId('recent-activity-row')
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.textContent).toContain('test-ssh')
  expect(row.textContent).toContain('events.targetConnected · overview.recentActivity.eventCount:12')
  expect(row.textContent).not.toContain('30d76c6b-442e-41be-b969-7b2668593890')
  expect(row.textContent).not.toContain('2026-10-21T02:49')
  expect(row.textContent).not.toContain('_')
  expect(row.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-21T02:49:54.025151399Z')

  const viewAll = screen.getByRole('link', { name: /overview.recentActivity.viewAll/ })
  expect(viewAll.getAttribute('href')).toBe('/admin/audit')
})
