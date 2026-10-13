import type { LogEntry } from '@/shared/lib/api/logs'
import type { RecentActivityEntry } from '@/shared/types/domain'
import { useQuery } from '@tanstack/react-query'
import { useIsAdmin } from '@/shared/hooks/use-info'
import { getLogs } from '@/shared/lib/api/logs'

function adaptLog(entry: LogEntry): RecentActivityEntry {
  return {
    id: entry.id,
    user: entry.username ?? '',
    when: entry.timestamp,
    action: entry.text,
    sessionId: entry.session_id,
  }
}

export function useRecentActivity(username: string | undefined) {
  const isAdmin = useIsAdmin()
  return useQuery<RecentActivityEntry[]>({
    queryKey: ['recent-activity', username ?? null],
    queryFn: async ({ signal }) => {
      if (!isAdmin || !username)
        return []
      const logs = await getLogs({ username, limit: 20 }, signal)
      return logs.map(adaptLog)
    },
    enabled: typeof username === 'string',
  })
}
