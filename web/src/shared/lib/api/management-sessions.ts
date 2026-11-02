import type { components } from './admin.types'
import { adminApi } from './http'

export type ManagementSession = components['schemas']['ManagementSession']

/** Authenticated browser (management) sessions held by the gateway. */
export async function listManagementSessions(signal?: AbortSignal): Promise<ManagementSession[]> {
  return adminApi.get<ManagementSession[]>('/management-sessions', signal)
}

/** Revoke a browser session; its cookie stops authenticating on the next request. */
export async function revokeManagementSession(id: string, signal?: AbortSignal): Promise<void> {
  await adminApi.delete<void>(`/management-sessions/${encodeURIComponent(id)}`, signal)
}
