import { createFileRoute } from '@tanstack/react-router'
import { TargetsPage } from '@/features/user/targets-page'

export const Route = createFileRoute('/targets/')({
  component: TargetsPage,
})
