import type { Target } from '@/shared/types/domain'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { AdminTargetDetailPage } from './admin-target-detail-page'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useParams: () => ({ targetId: 't2' }) }),
  useNavigate: () => navigate,
}))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({ usePastSessions: () => ({ data: { items: [], total: 0 } }) }))
vi.mock('@/features/targets/hooks/use-targets-queries', () => ({
  useTarget: () => ({ data: { id: 't2', name: 'db-01', kind: 'mysql' }, isLoading: false }),
}))
vi.mock('@/features/targets/components', () => ({
  useTargetDetailTabs: () => ({ list: [], value: 'overview', onChange: vi.fn() }),
  TargetDetailTabsBody: () => null,
  TargetFormDrawer: () => null,
  DeleteTargetDialog: () => null,
  TargetDetailHeader: ({ target, onOpenSqlConsole }: { target: Target, onOpenSqlConsole?: (target: Target) => void }) => (
    <button type="button" onClick={() => onOpenSqlConsole?.(target)}>sql</button>
  ),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('sql console opens a workspace tab', () => {
  const open = vi.spyOn(window, 'open')
  render(<AdminTargetDetailPage />)
  fireEvent.click(screen.getByRole('button', { name: 'sql' }))
  expect(open).not.toHaveBeenCalled()
  expect(useAppStore.getState().terminalTabs).toEqual([
    expect.objectContaining({ type: 'sql', kind: 'mysql', targetId: 't2', targetName: 'db-01' }),
  ])
  expect(navigate).toHaveBeenCalledWith({ to: '/sessions' })
})
