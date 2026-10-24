import type { QueryClient } from '@tanstack/react-query'
import type { LockStatus } from '@/shared/lib/api/encryption'
import { useQuery } from '@tanstack/react-query'
import { getLockStatus } from '@/shared/lib/api/encryption'

const LOCK_STATUS_QUERY_KEY = ['encryption', 'lock-status'] as const

const POLL_INTERVAL_MS = 3000
// Unlocked but not yet served by the full server: the switch-over takes a
// moment, so check back sooner.
const STARTING_POLL_INTERVAL_MS = 1000

function shouldPoll(status: LockStatus['status']): boolean {
  return status === 'locked' || status === 'uninitialized' || status === 'error'
}

// The pre-unlock listener reports `unlocked` with the database still closed;
// only the full server answers with `db_ready`.
export function isStarting(data: LockStatus): boolean {
  return data.status === 'unlocked' && !data.db_ready
}

export function useLockStatus() {
  return useQuery({
    queryKey: LOCK_STATUS_QUERY_KEY,
    queryFn: async ({ signal }) => getLockStatus(signal),
    // A failed fetch keeps polling: right after an unlock the pre-unlock
    // listener is gone before the full server binds, and the gate must not
    // stay on the error screen once the gateway answers again.
    refetchInterval: (query) => {
      const data = query.state.data
      if (query.state.status === 'error' || (data && isStarting(data)))
        return STARTING_POLL_INTERVAL_MS
      return data && shouldPoll(data.status) ? POLL_INTERVAL_MS : false
    },
    retry: 3,
    retryDelay: 1000,
    staleTime: 0,
  })
}

export async function invalidateLockStatus(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: LOCK_STATUS_QUERY_KEY })
}

// Optimistic seed used by the unlock / bootstrap success paths so the boot
// gate leaves the lock screen immediately instead of flickering through one
// extra "locked" render. The database is not ready yet: the gate waits for the
// full server to report it.
export function setLockStatusUnlocked(queryClient: QueryClient): void {
  queryClient.setQueryData<LockStatus>(LOCK_STATUS_QUERY_KEY, { status: 'unlocked', db_ready: false })
}
