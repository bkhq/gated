import { cleanup, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, expect, it, vi } from 'vitest'
import zhCommon from '../../../../public/locales/zh-CN/common.json'
import { AdminRolesPage } from './admin-roles-page'

vi.mock('@/shared/components/stat-card', () => ({
  StatCard: ({ label }: { label: string }) => <div data-testid="stat-card">{label}</div>,
}))
vi.mock('@/features/roles/components', () => ({ RoleFormDialog: () => null }))
vi.mock('@/features/roles/hooks/use-roles-queries', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
  return {
    useRoles: () => ({
      data: [
        { id: 'r1', name: 'admin', description: '', builtin: true },
        { id: 'r2', name: 'ops', description: '' },
      ],
      isLoading: false,
      isError: false,
    }),
    useDeleteRole: () => mutation,
    useRoleReferences: () => ({ data: undefined, isLoading: false }),
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
      <AdminRolesPage />
    </I18nextProvider>,
  )
  expect(screen.getByText('ops')).toBeTruthy()
  expect(screen.queryAllByTestId('stat-card')).toHaveLength(0)
})
