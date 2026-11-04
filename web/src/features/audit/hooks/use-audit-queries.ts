import type { GetLogsRequest } from '@/shared/lib/api/logs'
import { useInfiniteQuery } from '@tanstack/react-query'
import { getLogs } from '@/shared/lib/api/logs'
import { adaptLog } from '../audit-entry'

export const AUDIT_PAGE_SIZE = 200

export interface UseAuditOptions {
  plane?: 'session' | 'management'
}

/** Newest entries first; each further page continues before the oldest loaded entry. */
export function useAudit(options: UseAuditOptions = {}) {
  const { plane = 'session' } = options
  return useInfiniteQuery({
    queryKey: ['audit', plane],
    queryFn: async ({ pageParam, signal }) => {
      const request: GetLogsRequest = { limit: AUDIT_PAGE_SIZE, before: pageParam }
      const logs = await getLogs(request, signal, plane)
      return logs.map(adaptLog)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.length < AUDIT_PAGE_SIZE ? undefined : lastPage.at(-1)?.at,
    select: data => data.pages.flat(),
  })
}
