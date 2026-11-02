import type { components } from './admin.types'
import { adminApi } from './http'

export type SSHKnownHost = components['schemas']['SSHKnownHost']

export async function listKnownHosts(signal?: AbortSignal): Promise<SSHKnownHost[]> {
  return adminApi.get<SSHKnownHost[]>('/ssh/known-hosts', signal)
}

export async function deleteKnownHost(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/ssh/known-hosts/${encodeURIComponent(id)}`, signal)
}
