import type { LiveSession } from '@/shared/types/domain'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import enCommon from '../../../../public/locales/en/common.json'
import zhCommon from '../../../../public/locales/zh-CN/common.json'
import { AdminSessionDetailPage } from './admin-session-detail-page'

const SESSION_ID = '0f8e2c1a-5b7d-4e3f-9a21-6c4d8b0e7f12'

const state = vi.hoisted(() => ({ session: null as LiveSession | null }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useParams: () => ({ sessionId: SESSION_ID }) }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/features/recordings/components/recording-player', () => ({ RecordingPlayer: () => null }))
vi.mock('@/features/recordings/hooks/use-recording-queries', () => ({
  useSessionRecordings: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({
  useSession: () => ({ data: state.session, isLoading: false }),
}))

afterEach(cleanup)

function renderWith(sessionState: LiveSession['state']) {
  state.session = {
    id: SESSION_ID,
    user: 'alice',
    target: 'web-1',
    protocol: 'ssh',
    started: '2026-10-21T02:00:00Z',
    duration: '1m',
    state: sessionState,
  }
  render(<AdminSessionDetailPage />)
}

it('titles the page with user, target and protocol instead of the full id', () => {
  renderWith('closed')
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.textContent).toContain('alice → web-1 · ssh')
  expect(heading.textContent).not.toContain(SESSION_ID)
  const crumb = screen.getByRole('navigation').querySelector('[aria-current="page"]')
  expect(crumb?.textContent).toBe('alice → web-1 · ssh')
})

it('live session without recordings shows a neutral empty state', () => {
  renderWith('live')
  expect(screen.queryByText('monitor.detail.recordingPurged')).toBeNull()
  expect(screen.getByText('monitor.detail.recordingEmpty')).toBeTruthy()
  expect(screen.getByText('monitor.detail.recordingEmptyLiveHint')).toBeTruthy()
})

it('finished session without recordings does not claim the recording was purged', () => {
  renderWith('closed')
  expect(screen.queryByText('monitor.detail.recordingPurged')).toBeNull()
  expect(screen.getByText('monitor.detail.recordingEmpty')).toBeTruthy()
  expect(screen.getByText('monitor.detail.recordingEmptyHint')).toBeTruthy()
})

it('timeline uses the user-facing empty state', () => {
  renderWith('closed')
  expect(screen.getByText('monitor.detail.timelineEmpty')).toBeTruthy()
  expect(screen.getByText('monitor.detail.timelineEmptyHint')).toBeTruthy()
})

it('timeline empty copy is user-facing in both locales', () => {
  expect(zhCommon.monitor.detail.timelineEmpty).toBe('暂无事件')
  expect(zhCommon.monitor.detail.timelineEmptyHint).toBe('该会话没有可显示的事件。')
  expect(enCommon.monitor.detail.timelineEmptyHint).not.toMatch(/backend/i)
})
