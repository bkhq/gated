import type { components } from './admin.types'
import { adminApi } from './http'

export type SessionSnapshot = components['schemas']['SessionSnapshot']
export type PaginatedSessions = components['schemas']['PaginatedResponse_SessionSnapshot']

export interface ListSessionsQuery {
  offset?: number
  limit?: number
  active_only?: boolean
  closed_only?: boolean
  logged_in_only?: boolean
  protocol?: string
  search?: string
  since?: string
  target_id?: string
  username?: string
}

function toQueryString(query: ListSessionsQuery | undefined): string {
  if (!query)
    return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined)
      params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export async function listSessions(query?: ListSessionsQuery, signal?: AbortSignal): Promise<PaginatedSessions> {
  return adminApi.get<PaginatedSessions>(`/sessions${toQueryString(query)}`, signal)
}

export async function getSession(id: string, signal?: AbortSignal): Promise<SessionSnapshot> {
  return adminApi.get<SessionSnapshot>(`/sessions/${encodeURIComponent(id)}`, signal)
}

export async function closeSession(id: string, signal?: AbortSignal): Promise<void> {
  await adminApi.post<void>(`/sessions/${encodeURIComponent(id)}/close`, undefined, signal)
}

export async function deleteSession(id: string, signal?: AbortSignal): Promise<void> {
  await adminApi.delete<void>(`/sessions/${encodeURIComponent(id)}`, signal)
}

/** Delete all ended (historical) session records; returns the count removed. */
export async function deleteClosedSessions(signal?: AbortSignal): Promise<number> {
  return adminApi.delete<number>('/sessions/closed', signal)
}

/**
 * Same-origin path for the read-only live session-monitor WebSocket. The socket
 * emits `{ start, live }` then `{ data: AsciiCast }` frames and closes with
 * `{ end, reason? }` — the same wire format as the recording live stream.
 */
export function sessionMonitorUrl(id: string): string {
  return `/admin/api/sessions/${encodeURIComponent(id)}/monitor`
}
