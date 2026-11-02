import { createFileRoute } from '@tanstack/react-router'
import { ApiTokensPage } from '@/features/user/api-tokens-page'

export const Route = createFileRoute('/api-tokens')({
  component: ApiTokensPage,
})
