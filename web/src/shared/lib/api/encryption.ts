import { ApiError, userApi } from './http'

export type LockStatusValue = 'disabled' | 'uninitialized' | 'locked' | 'unlocked' | 'error'

export interface LockStatus {
  status: LockStatusValue
  db_ready: boolean
  retry_after?: number
}

export interface InitRequest {
  bootstrap_token: string
  master_password: string
}

export interface UnlockRequest {
  master_password: string
}

export interface RekeyMasterRequest {
  old_password: string
  new_password: string
}

export interface UnlockedResponse {
  status: 'unlocked'
}

export interface InitResponse extends UnlockedResponse {
  /** Path of the retained pre-migration plaintext database copy, if any. */
  plaintext_backup?: string | null
}

export interface LockedResponse {
  status: 'locked'
}

interface RateLimitedBody {
  code: 'rate_limited'
  message: string
  retry_after: number
}

export type RateLimitedError = ApiError & { body: RateLimitedBody }

export function isRateLimited(err: unknown): err is RateLimitedError {
  if (!(err instanceof ApiError) || err.status !== 429)
    return false
  const body = err.body
  if (!body || typeof body !== 'object')
    return false
  const candidate = body as Partial<RateLimitedBody>
  return candidate.code === 'rate_limited' && typeof candidate.retry_after === 'number'
}

export async function getLockStatus(signal?: AbortSignal): Promise<LockStatus> {
  return userApi.get<LockStatus>('/admin/encryption/lock-status', signal)
}

export async function initEncryption(req: InitRequest, signal?: AbortSignal): Promise<InitResponse> {
  return userApi.post<InitResponse>('/admin/encryption/init', req, signal)
}

export async function unlockEncryption(req: UnlockRequest, signal?: AbortSignal): Promise<UnlockedResponse> {
  return userApi.post<UnlockedResponse>('/admin/encryption/unlock', req, signal)
}

export async function lockEncryption(signal?: AbortSignal): Promise<LockedResponse> {
  return userApi.post<LockedResponse>('/admin/encryption/lock', undefined, signal)
}

export async function rekeyMasterPassword(req: RekeyMasterRequest, signal?: AbortSignal): Promise<UnlockedResponse> {
  return userApi.post<UnlockedResponse>('/admin/encryption/rekey-master', req, signal)
}
