import type { CommandReviewItem } from '@/shared/lib/api/command-reviews'
import type { ApiError } from '@/shared/lib/api/http'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { approveCommandReview, listCommandReviews, rejectCommandReview } from '@/shared/lib/api/command-reviews'

const KEY = ['command-reviews']

/**
 * Pending command reviews. Polls while enabled so paused SSH sessions surface
 * without a manual refresh; the list is empty unless an `action=review` rule
 * matched.
 */
export function useCommandReviews(pollMs = 4000) {
  return useQuery<CommandReviewItem[]>({
    queryKey: KEY,
    queryFn: async ({ signal }) => listCommandReviews(signal),
    refetchInterval: pollMs,
  })
}

export function useApproveCommandReview() {
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      await approveCommandReview(id)
      return { id }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: KEY }) },
  })
}

export function useRejectCommandReview() {
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      await rejectCommandReview(id)
      return { id }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: KEY }) },
  })
}
