import type { Target, TargetGroup } from '@/shared/types/domain'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AdminTargetsPage } from './admin-targets-page'

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {},
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
}))
vi.mock('@/shared/hooks/use-info', () => ({ useInfo: () => ({ data: undefined }) }))
vi.mock('@/features/targets/components/target-form-drawer', () => ({ TargetFormDrawer: () => null }))
vi.mock('@/features/targets/components/delete-target-dialog', () => ({ DeleteTargetDialog: () => null }))
vi.mock('@/features/targets/components/host-keys-dialog', () => ({ HostKeysDialog: () => null }))

const targets: Target[] = [
  { id: 't1', name: 'web-01', kind: 'ssh', host: 'web', port: 22, user: 'root', group: 'g1', groupName: 'prod' },
  { id: 't2', name: 'db-01', kind: 'mysql', host: 'db', port: 3306, user: 'root', group: '', groupName: '' },
]
const groups: TargetGroup[] = [
  { id: 'g1', name: 'prod', description: 'Production hosts' },
  { id: 'g2', name: 'empty', description: '' },
]

vi.mock('@/features/targets/hooks/use-targets-queries', () => ({
  useTargets: () => ({ data: targets, isLoading: false, isError: false }),
}))
vi.mock('@/features/target-groups/hooks/use-target-groups-queries', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
  return {
    useTargetGroups: () => ({ data: groups, isLoading: false, isError: false }),
    useCreateTargetGroup: () => mutation,
    useUpdateTargetGroup: () => mutation,
    useDeleteTargetGroup: () => mutation,
  }
})

beforeEach(() => {
  state.navigate.mockReset()
  state.search = {}
  localStorage.clear()
})
afterEach(cleanup)

it('lists targets in a table by default and switches to the groups view', () => {
  render(<AdminTargetsPage />)
  expect(screen.getAllByRole('row')).toHaveLength(3)
  fireEvent.click(screen.getByRole('tab', { name: 'targets.views.groups' }))
  expect(state.navigate).toHaveBeenCalledWith({ to: '/admin/targets', search: { view: 'groups' } })
})

it('shows groups as a table whose target count filters the targets view', () => {
  state.search = { view: 'groups' }
  render(<AdminTargetsPage />)
  const rows = screen.getAllByRole('row').slice(1)
  expect(rows).toHaveLength(2)
  const prod = rows.find(row => within(row).queryByText('prod'))!
  expect(within(prod).getByText('Production hosts')).toBeTruthy()
  fireEvent.click(within(prod).getByRole('button', { name: 'targetGroups.showTargets' }))
  expect(state.navigate).toHaveBeenCalledWith({ to: '/admin/targets', search: { group: 'g1' } })
})

it('filters targets by the group in the URL', () => {
  state.search = { group: 'g1' }
  render(<AdminTargetsPage />)
  const rows = screen.getAllByRole('row').slice(1)
  expect(rows).toHaveLength(1)
  expect(within(rows[0]!).getByText('web-01')).toBeTruthy()
})
