import { createFileRoute } from '@tanstack/react-router'
import { AdminTicketsPage } from '@/features/admin/config/admin-tickets-page'

export const Route = createFileRoute('/admin/tickets')({
  component: AdminTicketsPage,
})
