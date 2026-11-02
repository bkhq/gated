import type { GetLogsRequest, LogEntry } from '@/shared/lib/api/logs'
import type { AuditEntry } from '@/shared/types/domain'
import { useInfiniteQuery } from '@tanstack/react-query'
import { getLogs } from '@/shared/lib/api/logs'

function ageDaysSince(iso: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t))
    return 0
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
}

function adaptLog(entry: LogEntry): AuditEntry {
  const values = (entry.values && typeof entry.values === 'object' && !Array.isArray(entry.values))
    ? entry.values as Record<string, unknown>
    : {}
  return {
    id: entry.id,
    at: entry.timestamp,
    actor: entry.username ?? 'system',
    action: entry.text,
    values,
    sessionId: entry.session_id,
    ageDays: ageDaysSince(entry.timestamp),
  }
}

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
