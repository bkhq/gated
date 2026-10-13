import type { components as AdminComponents } from './admin.types'
import { adminApi } from './http'

export type AdminRole = AdminComponents['schemas']['Role']
export type AdminRoleDataRequest = AdminComponents['schemas']['RoleDataRequest']
export type AdminTarget = AdminComponents['schemas']['Target']
export type AdminUser = AdminComponents['schemas']['User']

export async function listAdminRoles(signal?: AbortSignal): Promise<AdminRole[]> {
  return adminApi.get<AdminRole[]>('/roles', signal)
}

export async function getAdminRole(id: string, signal?: AbortSignal): Promise<AdminRole> {
  return adminApi.get<AdminRole>(`/role/${encodeURIComponent(id)}`, signal)
}

export async function createAdminRole(body: AdminRoleDataRequest, signal?: AbortSignal): Promise<AdminRole> {
  return adminApi.post<AdminRole>('/roles', body, signal)
}

export async function updateAdminRole(id: string, body: AdminRoleDataRequest, signal?: AbortSignal): Promise<AdminRole> {
  return adminApi.put<AdminRole>(`/role/${encodeURIComponent(id)}`, body, signal)
}

export async function deleteAdminRole(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/role/${encodeURIComponent(id)}`, signal)
}

export async function listAdminRoleUsers(id: string, signal?: AbortSignal): Promise<AdminUser[]> {
  return adminApi.get<AdminUser[]>(`/role/${encodeURIComponent(id)}/users`, signal)
}

export async function listAdminRoleTargets(id: string, signal?: AbortSignal): Promise<AdminTarget[]> {
  return adminApi.get<AdminTarget[]>(`/role/${encodeURIComponent(id)}/targets`, signal)
}
