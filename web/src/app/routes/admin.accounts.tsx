import { createFileRoute } from '@tanstack/react-router'
import { AdminAccountsPage } from '@/features/admin/config/admin-accounts-page'

export const Route = createFileRoute('/admin/accounts')({
  component: AdminAccountsPage,
})
