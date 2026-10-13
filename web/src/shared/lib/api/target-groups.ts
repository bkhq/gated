import type { components } from './admin.types'
import { adminApi } from './http'

export type ApiTargetGroup = components['schemas']['TargetGroup']
export type ApiTargetGroupDataRequest = components['schemas']['TargetGroupDataRequest']

export async function listTargetGroups(signal?: AbortSignal): Promise<ApiTargetGroup[]> {
  return adminApi.get<ApiTargetGroup[]>('/target-groups', signal)
}

export async function getTargetGroup(id: string, signal?: AbortSignal): Promise<ApiTargetGroup> {
  return adminApi.get<ApiTargetGroup>(`/target-groups/${encodeURIComponent(id)}`, signal)
}

export async function createTargetGroup(body: ApiTargetGroupDataRequest, signal?: AbortSignal): Promise<ApiTargetGroup> {
  return adminApi.post<ApiTargetGroup>('/target-groups', body, signal)
}

export async function updateTargetGroup(id: string, body: ApiTargetGroupDataRequest, signal?: AbortSignal): Promise<ApiTargetGroup> {
  return adminApi.put<ApiTargetGroup>(`/target-groups/${encodeURIComponent(id)}`, body, signal)
}

export async function deleteTargetGroup(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/target-groups/${encodeURIComponent(id)}`, signal)
}
