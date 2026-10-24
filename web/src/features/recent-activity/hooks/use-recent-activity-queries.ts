import type { LogEntry } from '@/shared/lib/api/logs'
import type { RecentActivityEntry } from '@/shared/types/domain'
import { useQuery } from '@tanstack/react-query'
import { useIsAdmin } from '@/shared/hooks/use-info'
import { getLogs } from '@/shared/lib/api/logs'
import { eventLabelKey } from '@/shared/lib/event-label'

const MAX_ROWS = 8
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

function targetName(values: unknown): string | undefined {
  if (!values || typeof values !== 'object')
    return undefined
  const record = values as Record<string, unknown>
  const name = record.target ?? record.target_name
  return typeof name === 'string' && name !== '' ? name : undefined
}

export function aggregateRecentActivity(logs: LogEntry[]): RecentActivityEntry[] {
  const rows = new Map<string, RecentActivityEntry>()
  const oldestFirst = [...logs].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  for (const entry of oldestFirst) {
    const key = eventLabelKey(entry.text)
    const sessionId = entry.session_id && entry.session_id !== NIL_UUID ? entry.session_id : ''
    const id = sessionId || `event:${key}`
    let row = rows.get(id)
    if (!row) {
      row = { id, sessionId, user: entry.username ?? '', latest: entry.timestamp, events: [] }
      rows.set(id, row)
    }
    row.latest = entry.timestamp
    row.target ??= targetName(entry.values)
    if (!row.user && entry.username)
      row.user = entry.username
    const event = row.events.find(item => item.key === key)
    if (event)
      event.count += 1
    else
      row.events.push({ key, count: 1 })
  }
  return [...rows.values()]
    .sort((a, b) => Date.parse(b.latest) - Date.parse(a.latest))
    .slice(0, MAX_ROWS)
}

export function useRecentActivity(username: string | undefined) {
  const isAdmin = useIsAdmin()
  return useQuery<RecentActivityEntry[]>({
    queryKey: ['recent-activity', username ?? null],
    queryFn: async ({ signal }) => {
      if (!isAdmin || !username)
        return []
      const logs = await getLogs({ username, limit: 100 }, signal)
      return aggregateRecentActivity(logs)
    },
    enabled: typeof username === 'string',
  })
}
