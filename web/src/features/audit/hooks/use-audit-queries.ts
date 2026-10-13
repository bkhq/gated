import type { GetLogsRequest, LogEntry } from '@/shared/lib/api/logs'
import type { AuditEntry } from '@/shared/types/domain'
import { useQuery } from '@tanstack/react-query'
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

export interface UseAuditOptions {
  plane?: 'session' | 'management'
  filter?: GetLogsRequest
}

export function useAudit(options: UseAuditOptions = {}) {
  const { filter, plane = 'session' } = options
  const request: GetLogsRequest = filter ?? { limit: 200 }
  return useQuery<AuditEntry[]>({
    queryKey: ['audit', plane, request],
    queryFn: async ({ signal }) => {
      const logs = await getLogs(request, signal, plane)
      return logs.map(adaptLog)
    },
  })
}
