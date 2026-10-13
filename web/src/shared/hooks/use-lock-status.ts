import type { QueryClient } from '@tanstack/react-query'
import type { LockStatus } from '@/shared/lib/api/encryption'
import { useQuery } from '@tanstack/react-query'
import { getLockStatus } from '@/shared/lib/api/encryption'

const LOCK_STATUS_QUERY_KEY = ['encryption', 'lock-status'] as const

const POLL_INTERVAL_MS = 3000

function shouldPoll(status: LockStatus['status']): boolean {
  return status === 'locked' || status === 'uninitialized' || status === 'error'
}

export function useLockStatus() {
  return useQuery({
    queryKey: LOCK_STATUS_QUERY_KEY,
    queryFn: async ({ signal }) => getLockStatus(signal),
    refetchInterval: query =>
      query.state.data && shouldPoll(query.state.data.status) ? POLL_INTERVAL_MS : false,
    retry: false,
    staleTime: 0,
  })
}

export async function invalidateLockStatus(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: LOCK_STATUS_QUERY_KEY })
}

// Optimistic seed used by the unlock / bootstrap success paths so the boot
// gate transitions immediately instead of flickering through one extra
// "locked" render while the post-success refetch is in flight.
export function setLockStatusUnlocked(queryClient: QueryClient): void {
  queryClient.setQueryData<LockStatus>(LOCK_STATUS_QUERY_KEY, { status: 'unlocked', db_ready: true })
}
