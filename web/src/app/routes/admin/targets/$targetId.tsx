import { createFileRoute } from '@tanstack/react-router'
import { AdminTargetDetailPage } from '@/features/admin/config/admin-target-detail-page'

export const Route = createFileRoute('/admin/targets/$targetId')({
  component: AdminTargetDetailPage,
})
