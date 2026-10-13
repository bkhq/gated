import { createFileRoute } from '@tanstack/react-router'
import { AdminTargetGroupsPage } from '@/features/admin/config/admin-config-pages'

export const Route = createFileRoute('/admin/target-groups')({
  component: AdminTargetGroupsPage,
})
