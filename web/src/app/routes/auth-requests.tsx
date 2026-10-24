import { createFileRoute } from '@tanstack/react-router'
import { AuthRequestsPage } from '@/features/auth/auth-requests-page'

export const Route = createFileRoute('/auth-requests')({
  component: AuthRequestsPage,
})
