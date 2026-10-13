import type { Target } from '@/shared/types/domain'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { TargetDetailPage } from './target-detail-page'

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  target: undefined as Pick<Target, 'id' | 'name' | 'kind'> | undefined,
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useParams: () => ({ targetId: 't1' }) }),
  useNavigate: () => state.navigate,
}))
vi.mock('@/shared/hooks/use-info', () => ({ useInfo: () => ({ data: undefined }) }))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({
  useMySessionsForTarget: () => ({ data: [], dataUpdatedAt: 0, isFetching: false, refetch: vi.fn() }),
}))
vi.mock('@/features/targets/hooks/use-targets-queries', () => ({
  useTarget: () => ({ data: state.target, isLoading: false, isError: false, isFetching: false, dataUpdatedAt: 0, refetch: vi.fn() }),
}))
vi.mock('@/features/targets/components', () => ({
  useTargetDetailTabs: () => ({ list: [], value: 'overview', onChange: vi.fn() }),
  TargetDetailTabsBody: () => null,
  TargetDetailHeader: ({ target, onConnect, onOpenSqlConsole }: {
    target: Target
    onConnect?: (target: Target) => void
    onOpenSqlConsole?: (target: Target) => void
  }) => (
    <div>
      {onConnect ? <button type="button" onClick={() => onConnect(target)}>connect</button> : null}
      {onOpenSqlConsole ? <button type="button" onClick={() => onOpenSqlConsole(target)}>sql</button> : null}
    </div>
  ),
}))

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState())
  state.navigate.mockReset()
  state.target = { id: 't1', name: 'web-01', kind: 'ssh' }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('connect opens a terminal workspace tab instead of a browser tab', () => {
  const open = vi.spyOn(window, 'open')
  render(<TargetDetailPage />)
  fireEvent.click(screen.getByRole('button', { name: 'connect' }))
  expect(open).not.toHaveBeenCalled()
  const { terminalTabs, activeTerminalTabId } = useAppStore.getState()
  expect(terminalTabs).toEqual([expect.objectContaining({ type: 'terminal', kind: 'ssh', targetId: 't1', targetName: 'web-01' })])
  expect(activeTerminalTabId).toBe(terminalTabs[0]?.id)
  expect(state.navigate).toHaveBeenCalledWith({ to: '/sessions' })
})

it('sql console opens a workspace tab', () => {
  state.target = { id: 't2', name: 'db-01', kind: 'mysql' }
  const open = vi.spyOn(window, 'open')
  render(<TargetDetailPage />)
  fireEvent.click(screen.getByRole('button', { name: 'sql' }))
  expect(open).not.toHaveBeenCalled()
  expect(useAppStore.getState().terminalTabs).toEqual([
    expect.objectContaining({ type: 'sql', kind: 'mysql', targetId: 't2', targetName: 'db-01' }),
  ])
  expect(state.navigate).toHaveBeenCalledWith({ to: '/sessions' })
})
