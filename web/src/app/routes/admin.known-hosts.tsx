import { createFileRoute } from '@tanstack/react-router'
import { AdminKnownHostsPage } from '@/features/admin/config/admin-known-hosts-page'

export const Route = createFileRoute('/admin/known-hosts')({
  component: AdminKnownHostsPage,
})
