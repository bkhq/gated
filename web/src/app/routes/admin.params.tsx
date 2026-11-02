import type { SettingsTab } from '@/features/admin/config/settings-tabs'
import { createFileRoute } from '@tanstack/react-router'
import { AdminParamsPage } from '@/features/admin/config/admin-params-page'
import { SETTINGS_TABS } from '@/features/admin/config/settings-tabs'

export const Route = createFileRoute('/admin/params')({
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab: SETTINGS_TABS.find(tab => tab === search.tab),
  }),
  component: AdminParamsPage,
})
