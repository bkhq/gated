import type { components } from './user.types'
import { loginDestination } from '@/features/auth/login-destination'
import { userApi } from './http'

export type SsoProvider = components['schemas']['SsoProviderDescription']
export type SsoStartResponse = components['schemas']['StartSsoResponseParams']

export async function listProviders(signal?: AbortSignal): Promise<SsoProvider[]> {
  return userApi.get<SsoProvider[]>('/sso/providers', signal)
}

export async function startSso(name: string, signal?: AbortSignal): Promise<SsoStartResponse> {
  return userApi.get<SsoStartResponse>(`/sso/providers/${encodeURIComponent(name)}/start?next=${encodeURIComponent(loginDestination(window.location.search))}`, signal)
}
