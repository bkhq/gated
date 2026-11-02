import type { components } from './admin.types'
import { adminApi } from './http'

export type StoredSSHKey = components['schemas']['StoredSSHKey']
export type ImportSSHKeyRequest = components['schemas']['ImportSSHKeyRequest']

export async function listSshKeys(signal?: AbortSignal): Promise<StoredSSHKey[]> {
  return adminApi.get<StoredSSHKey[]>('/ssh/keys', signal)
}

export async function generateSshKeys(signal?: AbortSignal): Promise<StoredSSHKey[]> {
  return adminApi.post<StoredSSHKey[]>('/ssh/keys/generate', undefined, signal)
}

export async function importSshKey(req: ImportSSHKeyRequest, signal?: AbortSignal): Promise<StoredSSHKey> {
  return adminApi.post<StoredSSHKey>('/ssh/keys/import', req, signal)
}
