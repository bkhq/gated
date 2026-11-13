import type { components } from './admin.types'
import { adminApi } from './http'

export type IpBlock = components['schemas']['IpBlock']
export type UserLockout = components['schemas']['UserLockout']

export async function listIpBlocks(signal?: AbortSignal): Promise<IpBlock[]> {
  return adminApi.get<IpBlock[]>('/login-protection/ip-blocks', signal)
}

export async function liftIpBlock(ip: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/login-protection/ip-blocks/${encodeURIComponent(ip)}`, signal)
}

export async function listUserLockouts(signal?: AbortSignal): Promise<UserLockout[]> {
  return adminApi.get<UserLockout[]>('/login-protection/user-lockouts', signal)
}

export async function liftUserLockout(username: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/login-protection/user-lockouts/${encodeURIComponent(username)}`, signal)
}
