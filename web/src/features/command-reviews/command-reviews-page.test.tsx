import type { CommandReviewItem } from '@/shared/lib/api/command-reviews'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/features/command-reviews/hooks/use-command-reviews-queries', () => ({
  useCommandReviews: vi.fn(),
  useApproveCommandReview: vi.fn(),
  useRejectCommandReview: vi.fn(),
}))

const hooks = await import('@/features/command-reviews/hooks/use-command-reviews-queries')
const useCommandReviews = vi.mocked(hooks.useCommandReviews)
const useApproveCommandReview = vi.mocked(hooks.useApproveCommandReview)
const useRejectCommandReview = vi.mocked(hooks.useRejectCommandReview)

const { CommandReviewsPage } = await import('./command-reviews-page')

const REVIEW: CommandReviewItem = {
  id: 'rev-1',
  session_id: 'sess-1',
  user_id: 'u-1',
  username: 'alice',
  target_id: 't-1',
  target_name: 'web-1',
  origin: 'exec',
  command: 'rm -rf /var',
  acl_rule_id: 5,
  acl_rule_name: 'destructive',
  requested_at: '2026-07-01T10:00:00Z',
}

const approveMock = vi.fn().mockResolvedValue({ id: 'rev-1' })
const rejectMock = vi.fn().mockResolvedValue({ id: 'rev-1' })

beforeEach(() => {
  vi.clearAllMocks()
  useCommandReviews.mockReturnValue({ data: [REVIEW], isLoading: false } as unknown as ReturnType<typeof hooks.useCommandReviews>)
  useApproveCommandReview.mockReturnValue({ mutateAsync: approveMock, isPending: false } as unknown as ReturnType<typeof hooks.useApproveCommandReview>)
  useRejectCommandReview.mockReturnValue({ mutateAsync: rejectMock, isPending: false } as unknown as ReturnType<typeof hooks.useRejectCommandReview>)
})

describe('commandReviewsPage', () => {
  it('renders a pending review with its command', () => {
    render(<CommandReviewsPage />)
    expect(screen.getByText('rm -rf /var')).toBeInTheDocument()
    expect(screen.getByText('destructive')).toBeInTheDocument()
  })

  it('approves a review on click', () => {
    render(<CommandReviewsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'commandReviews.actions.approve' }))
    expect(approveMock).toHaveBeenCalledWith('rev-1')
  })

  it('rejects a review on click', () => {
    render(<CommandReviewsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'commandReviews.actions.reject' }))
    expect(rejectMock).toHaveBeenCalledWith('rev-1')
  })
})
