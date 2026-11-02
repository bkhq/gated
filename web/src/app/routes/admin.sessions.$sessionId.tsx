import { createFileRoute } from '@tanstack/react-router'
import { AdminSessionDetailPage } from '@/features/admin/monitor/admin-session-detail-page'

export const Route = createFileRoute('/admin/sessions/$sessionId')({
  component: AdminSessionDetailPage,
})
