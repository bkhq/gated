import type { components } from './admin.types'
import { adminApi } from './http'

export type BackedParameters = components['schemas']['ParameterValues']
export type BackedParametersUpdate = components['schemas']['ParameterUpdate']

export async function getSettings(signal?: AbortSignal): Promise<BackedParameters> {
  return adminApi.get<BackedParameters>('/parameters', signal)
}

export async function updateSettings(patch: BackedParametersUpdate, signal?: AbortSignal): Promise<void> {
  await adminApi.put<void>('/parameters', patch, signal)
}
