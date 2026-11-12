import { createFileRoute } from '@tanstack/react-router'
import { AdminSessionsPage } from '@/features/admin/monitor/admin-sessions-page'

export const Route = createFileRoute('/admin/sessions/')({
  // `ticket` scopes the list to the sessions opened with one ticket.
  validateSearch: (search: Record<string, unknown>): { ticket?: string } =>
    typeof search.ticket === 'string' && search.ticket ? { ticket: search.ticket } : {},
  component: AdminSessionsPage,
})
