import type { components } from './admin.types'
import type { AsciiCastLine } from '@/features/recordings/types'
import { parseAsciiCastLine } from '@/features/recordings/types'
import { adminApi, ApiError } from './http'

export type Recording = components['schemas']['Recording']
export type RecordingKind = components['schemas']['RecordingKind']
export type HttpProxyRecordingItem = components['schemas']['HttpProxyRecordingItem']

export async function getRecording(id: string, signal?: AbortSignal): Promise<Recording> {
  return adminApi.get<Recording>(`/recordings/${encodeURIComponent(id)}`, signal)
}

export async function getSessionRecordings(sessionId: string, signal?: AbortSignal): Promise<Recording[]> {
  return adminApi.get<Recording[]>(`/sessions/${encodeURIComponent(sessionId)}/recordings`, signal)
}

export async function getHttpProxyRecording(id: string, signal?: AbortSignal): Promise<HttpProxyRecordingItem[]> {
  return adminApi.get<HttpProxyRecordingItem[]>(`/recordings/${encodeURIComponent(id)}/http-proxy`, signal)
}

// The /cast endpoint returns `text/plain` newline-delimited JSON, not a JSON
// document — fetch it directly and surface non-2xx as ApiError so callers can
// treat it uniformly with the typed adminApi.* helpers.
export async function getRecordingCastText(id: string, signal?: AbortSignal): Promise<string> {
  const url = `/admin/api/recordings/${encodeURIComponent(id)}/cast`
  const response = await fetch(url, { credentials: 'include', signal })
  if (!response.ok) {
    const message = response.statusText.length > 0 ? response.statusText : `HTTP ${response.status}`
    throw new ApiError(response.status, message, undefined)
  }
  return response.text()
}

export function parseAsciiCast(text: string): AsciiCastLine[] {
  const out: AsciiCastLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.length === 0)
      continue
    const line = parseAsciiCastLine(raw)
    if (line !== null)
      out.push(line)
  }
  return out
}

export function recordingTcpdumpUrl(id: string): string {
  return `/admin/api/recordings/${encodeURIComponent(id)}/tcpdump`
}

export function recordingCastUrl(id: string): string {
  return `/admin/api/recordings/${encodeURIComponent(id)}/cast`
}

export function recordingStreamUrl(id: string): string {
  return `/admin/api/recordings/${encodeURIComponent(id)}/stream`
}
