import type { components } from './admin.types'
import { adminApi } from './http'

export type SSHKnownHost = components['schemas']['SSHKnownHost']
export type AddSshKnownHostRequest = components['schemas']['AddSshKnownHostRequest']
export type CheckSshHostKeyRequest = components['schemas']['CheckSshHostKeyRequest']
export type CheckSshHostKeyResponse = components['schemas']['CheckSshHostKeyResponseBody']

export async function listKnownHosts(signal?: AbortSignal): Promise<SSHKnownHost[]> {
  return adminApi.get<SSHKnownHost[]>('/ssh/known-hosts', signal)
}

export async function deleteKnownHost(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/ssh/known-hosts/${encodeURIComponent(id)}`, signal)
}

/** Trust a host key; trusting the same key again returns the existing entry. */
export async function addKnownHost(req: AddSshKnownHostRequest, signal?: AbortSignal): Promise<SSHKnownHost> {
  return adminApi.post<SSHKnownHost>('/ssh/known-hosts', req, signal)
}

/** Connect to the host through the gateway and read its host key, without signing in. */
export async function checkSshHostKey(req: CheckSshHostKeyRequest, signal?: AbortSignal): Promise<CheckSshHostKeyResponse> {
  return adminApi.post<CheckSshHostKeyResponse>('/ssh/check-host-key', req, signal)
}
