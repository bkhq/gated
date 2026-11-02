import { createFileRoute } from '@tanstack/react-router'
import { AdminUsersPage } from '@/features/admin/config/admin-users-page'

export const Route = createFileRoute('/admin/users')({
  component: AdminUsersPage,
})
