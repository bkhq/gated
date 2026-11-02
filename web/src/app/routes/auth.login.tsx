import { createFileRoute } from '@tanstack/react-router'
import { LoginPage } from '@/features/auth/login-page'

export const Route = createFileRoute('/auth/login')({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: LoginPage,
})
