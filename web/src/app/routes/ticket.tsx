import { createFileRoute } from '@tanstack/react-router'
import { ClaimPage } from '@/features/tickets/claim-page'

export const Route = createFileRoute('/ticket')({
  component: ClaimPage,
})
