import { createFileRoute } from '@tanstack/react-router'
import { AdminRecordingPage } from '@/features/admin/monitor/admin-session-detail-page'

export const Route = createFileRoute('/admin/recordings/$recordingId')({
  component: AdminRecordingPage,
})
