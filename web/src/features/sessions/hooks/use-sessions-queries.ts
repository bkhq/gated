import type { ManagementSession } from '@/shared/lib/api/management-sessions'
import type { SessionSnapshot } from '@/shared/lib/api/sessions'
import type { LiveSession } from '@/shared/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { listManagementSessions, revokeManagementSession } from '@/shared/lib/api/management-sessions'
import { profileApi } from '@/shared/lib/api/profile'
import { closeSession, deleteClosedSessions, deleteSession, getSession, listSessions } from '@/shared/lib/api/sessions'

function formatDuration(startIso: string, endIso: string | undefined): string {
  const start = Date.parse(startIso)
  if (Number.isNaN(start))
    return ''
  const end = endIso ? Date.parse(endIso) : Date.now()
  if (Number.isNaN(end))
    return ''
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function adaptSession(snapshot: SessionSnapshot): LiveSession {
  const isLive = !snapshot.ended
  return {
    id: snapshot.id,
    user: snapshot.username ?? '',
    target: snapshot.target?.name ?? '',
    protocol: snapshot.protocol,
    started: snapshot.started,
    duration: formatDuration(snapshot.started, snapshot.ended),
    state: isLive ? 'live' : 'closed',
  }
}

async function fetchAllSessions(signal?: AbortSignal): Promise<LiveSession[]> {
  const response = await listSessions({ limit: 500 }, signal)
  return response.items.map(adaptSession)
}

export function useLiveSessions() {
  return useQuery<LiveSession[]>({
    queryKey: ['sessions', 'live'],
    queryFn: async ({ signal }) => {
      const all = await fetchAllSessions(signal)
      return all.filter(session => session.state === 'live')
    },
  })
}

export function usePastSessions() {
  return useQuery<LiveSession[]>({
    queryKey: ['sessions', 'past'],
    queryFn: async ({ signal }) => {
      const all = await fetchAllSessions(signal)
      return all.filter(session => session.state !== 'live')
    },
  })
}

// User surface: the caller's own sessions from `/api/profile/sessions`. The
// `/admin/api/sessions` list above is admin-only and 403s for everyone else.
export function useMySessions() {
  return useQuery<LiveSession[]>({
    queryKey: ['sessions', 'mine'],
    queryFn: async ({ signal }) => {
      const snapshots = await profileApi.sessions.list(signal)
      return snapshots.map(adaptSession)
    },
  })
}

export function useMyLiveSessions() {
  const query = useMySessions()
  const live = React.useMemo(() => (query.data ?? []).filter(session => session.state === 'live'), [query.data])
  return { ...query, data: query.data === undefined ? undefined : live }
}

export function useMySessionsForTarget(targetName: string | undefined) {
  const query = useMySessions()
  const matched = React.useMemo(() => {
    const list = (query.data ?? []).filter(item => item.target === targetName)
    list.sort((a, b) => {
      if (a.state === 'live' && b.state !== 'live')
        return -1
      if (b.state === 'live' && a.state !== 'live')
        return 1
      return 0
    })
    return list
  }, [query.data, targetName])
  return { ...query, data: query.data === undefined ? undefined : matched }
}

export function useSession(id: string | undefined) {
  return useQuery<LiveSession | null>({
    queryKey: ['sessions', 'one', id ?? null],
    queryFn: async ({ signal }) => {
      if (!id)
        return null
      const snapshot = await getSession(id, signal)
      return adaptSession(snapshot)
    },
    enabled: typeof id === 'string',
  })
}

export function useForceCloseSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0)
        return { ids }
      await Promise.allSettled(ids.map(async id => closeSession(id)))
      return { ids }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

/** Delete one or more session records (and their recordings/logs). */
export function useDeleteSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0)
        return { ids }
      await Promise.allSettled(ids.map(async id => deleteSession(id)))
      return { ids }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

/** Delete every ended (historical) session record in one call. */
export function useClearSessionHistory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => deleteClosedSessions(),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

/** Authenticated browser (management) sessions, separate from proxy sessions. */
export function useManagementSessions() {
  return useQuery<ManagementSession[]>({
    queryKey: ['sessions', 'management'],
    queryFn: async ({ signal }) => listManagementSessions(signal),
  })
}

export function useRevokeManagementSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => revokeManagementSession(id),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['sessions', 'management'] }),
  })
}
