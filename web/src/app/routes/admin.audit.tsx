import { createFileRoute } from '@tanstack/react-router'
import { AuditPage, validateAuditSearch } from '@/features/audit/audit-page'

export const Route = createFileRoute('/admin/audit')({
  validateSearch: validateAuditSearch,
  component: AuditPage,
})
