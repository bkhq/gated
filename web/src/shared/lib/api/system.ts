import type { components } from './admin.types'
import { adminApi } from './http'

type Schemas = components['schemas']

export type UpdateStatus = Schemas['UpdateStatus']
export type LifecycleRequest = Schemas['LifecycleRequest']

export async function getUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  return adminApi.get<UpdateStatus>('/system/update', signal)
}

export async function checkForUpdate(signal?: AbortSignal): Promise<number> {
  return (await adminApi.post<Schemas['UpdateCheck']>('/system/update/check', undefined, signal)).nonce
}

export async function applyUpdate(body: LifecycleRequest, signal?: AbortSignal): Promise<void> {
  await adminApi.post<void>('/system/update', body, signal)
}

export async function restartGateway(body: LifecycleRequest, signal?: AbortSignal): Promise<void> {
  await adminApi.post<void>('/system/restart', body, signal)
}
