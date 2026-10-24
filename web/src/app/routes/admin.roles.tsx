import { createFileRoute } from '@tanstack/react-router'
import { AdminRolesPage } from '@/features/admin/config/admin-roles-page'

export const Route = createFileRoute('/admin/roles')({
  component: AdminRolesPage,
})
