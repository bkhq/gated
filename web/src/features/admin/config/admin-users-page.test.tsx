import { cleanup, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, expect, it, vi } from 'vitest'
import zhCommon from '../../../../public/locales/zh-CN/common.json'
import { AdminUsersPage } from './admin-users-page'

vi.mock('@/shared/components/stat-card', () => ({
  StatCard: ({ label }: { label: string }) => <div data-testid="stat-card">{label}</div>,
}))
vi.mock('@/features/users/components', () => ({ UserFormDialog: () => null }))
vi.mock('@/features/roles/hooks/use-roles-queries', () => ({
  useRoles: () => ({ data: [{ id: 'r1', name: 'admin', description: '', builtin: true }], isLoading: false }),
}))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({
  useLiveSessions: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/features/users/hooks/use-users-queries', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
  return {
    useUsers: () => ({ data: [{ id: 'u1', username: 'alice', name: 'Alice', roles: ['admin'] }], isLoading: false, isError: false }),
    useBulkDeleteUsers: () => mutation,
    useDeleteUser: () => mutation,
    useSetUserPassword: () => mutation,
    useUserReferences: () => ({ data: undefined, isLoading: false }),
  }
})

await i18n.use(initReactI18next).init({
  lng: 'zh-CN',
  resources: { 'zh-CN': { common: zhCommon } },
  defaultNS: 'common',
  interpolation: { escapeValue: false },
})

afterEach(cleanup)

it('renders no stat cards', () => {
  render(
    <I18nextProvider i18n={i18n}>
      <AdminUsersPage />
    </I18nextProvider>,
  )
  expect(screen.getByText('Alice')).toBeTruthy()
  expect(screen.queryAllByTestId('stat-card')).toHaveLength(0)
})
