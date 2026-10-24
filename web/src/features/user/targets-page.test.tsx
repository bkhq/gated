import type { LiveSession, Target } from '@/shared/types/domain'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TargetsPage } from './targets-page'

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  openTerminalTab: vi.fn(),
  targets: [] as Target[],
  sessions: [] as LiveSession[],
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))
vi.mock('@/store/app-store', () => ({
  useAppStore: (select: (s: { openTerminalTab: typeof state.openTerminalTab }) => unknown) => select({ openTerminalTab: state.openTerminalTab }),
}))
vi.mock('@/shared/hooks/use-info', () => ({ useInfo: () => ({ data: undefined }) }))
vi.mock('@/features/targets/hooks/use-targets-queries', () => ({
  useTargets: () => ({ data: state.targets, isLoading: false, isError: false, refetch: vi.fn() }),
}))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({
  useMySessions: () => ({ data: state.sessions, isLoading: false }),
}))

function target(id: string, name: string, kind: Target['kind'], group = '', groupName?: string): Target {
  return { id, name, kind, host: `${name}.local`, port: 22, user: 'root', group, groupName }
}

function session(id: string, targetName: string): LiveSession {
  return { id, user: 'alice', target: targetName, protocol: 'ssh', started: '', duration: '', state: 'closed' }
}

beforeEach(() => {
  state.navigate.mockReset()
  state.openTerminalTab.mockReset()
  localStorage.clear()
  state.targets = [
    target('t1', 'web-01', 'ssh', 'g1', 'prod'),
    target('t2', 'db-01', 'mysql'),
    target('t3', 'pg-01', 'postgres'),
    target('t4', 'grafana', 'http'),
  ]
  state.sessions = [
    session('s1', 'web-01'),
    session('s2', 'web-01'),
    session('s3', 'db-01'),
    session('s4', 'db-01'),
    session('s5', 'gone-01'),
  ]
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function statValue(label: string): string | null | undefined {
  return screen.getByText(label).parentElement?.nextElementSibling?.textContent
}

it('recently used counts distinct accessible targets, never more than the total', () => {
  render(<TargetsPage />)
  expect(statValue('targets.stats.reachable')).toBe('4')
  expect(statValue('targets.stats.recentlyUsed')).toBe('2')
})

it('defaults to the table and remembers the chosen view', () => {
  render(<TargetsPage />)
  expect(screen.getAllByRole('row')).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: 'a11y.targets.viewGrid' }))
  expect(screen.queryAllByRole('row')).toHaveLength(0)
  cleanup()
  render(<TargetsPage />)
  expect(screen.queryAllByRole('row')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'a11y.targets.viewGrid' }).getAttribute('aria-pressed')).toBe('true')
})

it('cards hide the ungrouped label, connect terminal targets and offer details for HTTP', () => {
  localStorage.setItem('gated.targets.view', 'grid')
  render(<TargetsPage />)
  expect(screen.queryByText('targets.ungrouped')).toBeNull()
  expect(screen.getByText('prod')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'actions.connect' })).toHaveLength(3)
  fireEvent.click(screen.getAllByRole('button', { name: 'actions.connect' })[0]!)
  expect(state.openTerminalTab).toHaveBeenCalledWith({ type: 'terminal', kind: 'mysql', targetId: 't2', targetName: 'db-01' })
  expect(state.navigate).toHaveBeenCalledWith({ to: '/sessions' })
  fireEvent.click(screen.getByRole('button', { name: 'actions.details' }))
  expect(state.navigate).toHaveBeenLastCalledWith({ to: '/targets/$targetId', params: { targetId: 't4' } })
})

it('table hides the ungrouped label, connects terminal targets and offers details for HTTP', () => {
  render(<TargetsPage />)
  const rows = screen.getAllByRole('row').slice(1)
  expect(rows).toHaveLength(4)
  expect(screen.queryByText('targets.ungrouped')).toBeNull()
  const httpRow = rows.find(row => within(row).queryByText('grafana'))!
  expect(within(httpRow).queryByRole('button', { name: 'actions.connect' })).toBeNull()
  fireEvent.click(within(httpRow).getByRole('button', { name: 'actions.details' }))
  expect(state.navigate).toHaveBeenCalledWith({ to: '/targets/$targetId', params: { targetId: 't4' } })
  const sshRow = rows.find(row => within(row).queryByText('web-01'))!
  fireEvent.click(within(sshRow).getByRole('button', { name: 'actions.connect' }))
  expect(state.openTerminalTab).toHaveBeenCalledWith({ type: 'terminal', kind: 'ssh', targetId: 't1', targetName: 'web-01' })
  expect(state.navigate).toHaveBeenLastCalledWith({ to: '/sessions' })
})
