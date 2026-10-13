import { createFileRoute } from '@tanstack/react-router'
import { AdminParamsPage } from '@/features/admin/config/admin-params-page'

export const Route = createFileRoute('/admin/params')({
  component: AdminParamsPage,
})
