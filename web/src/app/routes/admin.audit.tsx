import { createFileRoute } from '@tanstack/react-router'
import { AdminAuditPage } from '@/features/admin/monitor/admin-audit-page'

export const Route = createFileRoute('/admin/audit')({
  component: AdminAuditPage,
})
