import { createFileRoute } from '@tanstack/react-router'
import { AdminTargetsPage } from '@/features/admin/config/admin-targets-page'

export const Route = createFileRoute('/admin/targets/')({
  component: AdminTargetsPage,
})
