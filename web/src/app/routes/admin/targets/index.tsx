import { createFileRoute } from '@tanstack/react-router'
import { AdminTargetsPage } from '@/features/admin/config/admin-targets-page'

export const Route = createFileRoute('/admin/targets/')({
  validateSearch: (search: Record<string, unknown>): { view?: 'groups', group?: string } => ({
    view: search.view === 'groups' ? 'groups' : undefined,
    group: typeof search.group === 'string' && search.group ? search.group : undefined,
  }),
  component: AdminTargetsPage,
})
