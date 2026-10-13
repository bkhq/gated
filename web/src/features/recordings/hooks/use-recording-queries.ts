import type { AsciiCastLine } from '@/features/recordings/types'
import type {
  HttpProxyRecordingItem,
  Recording,
} from '@/shared/lib/api/recordings'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/shared/lib/api/http'
import {
  getHttpProxyRecording,
  getRecording,
  getRecordingCastText,
  getSessionRecordings,
  parseAsciiCast,
} from '@/shared/lib/api/recordings'

function retryUnless404(_failures: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status === 404)
}

export function useRecording(id: string | undefined) {
  return useQuery<Recording>({
    queryKey: ['recordings', 'one', id ?? null],
    queryFn: async ({ signal }) => getRecording(id as string, signal),
    enabled: typeof id === 'string',
    retry: retryUnless404,
  })
}

export function useSessionRecordings(sessionId: string | undefined) {
  return useQuery<Recording[]>({
    queryKey: ['recordings', 'session', sessionId ?? null],
    queryFn: async ({ signal }) => getSessionRecordings(sessionId as string, signal),
    enabled: typeof sessionId === 'string',
    retry: retryUnless404,
  })
}

export function useHttpProxyRecording(id: string | undefined, enabled: boolean) {
  return useQuery<HttpProxyRecordingItem[]>({
    queryKey: ['recordings', 'http-proxy', id ?? null],
    queryFn: async ({ signal }) => getHttpProxyRecording(id as string, signal),
    enabled: typeof id === 'string' && enabled,
    retry: retryUnless404,
  })
}

export function useRecordingCast(id: string | undefined, enabled: boolean) {
  return useQuery<AsciiCastLine[]>({
    queryKey: ['recordings', 'cast', id ?? null],
    queryFn: async ({ signal }) => {
      const text = await getRecordingCastText(id as string, signal)
      return parseAsciiCast(text)
    },
    enabled: typeof id === 'string' && enabled,
    retry: retryUnless404,
  })
}
