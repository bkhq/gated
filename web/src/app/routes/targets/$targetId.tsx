import { createFileRoute } from '@tanstack/react-router'
import { TargetDetailPage } from '@/features/user/target-detail-page'

export const Route = createFileRoute('/targets/$targetId')({
  component: TargetDetailPage,
})
