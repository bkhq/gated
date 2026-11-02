import { createFileRoute } from '@tanstack/react-router'
import { AdminSessionsPage } from '@/features/admin/monitor/admin-sessions-page'

export const Route = createFileRoute('/admin/sessions/')({
  component: AdminSessionsPage,
})
