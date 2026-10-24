import { createFileRoute } from '@tanstack/react-router'
import { CommandReviewsPage } from '@/features/command-reviews/command-reviews-page'

export const Route = createFileRoute('/admin/command-reviews')({
  component: CommandReviewsPage,
})
