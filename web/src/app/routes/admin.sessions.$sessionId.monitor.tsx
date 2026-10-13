import { createFileRoute } from '@tanstack/react-router'
import { SessionMonitorPage } from '@/features/sessions/components/session-monitor-page'

export const Route = createFileRoute('/admin/sessions/$sessionId/monitor')({
  component: SessionMonitorPage,
})
