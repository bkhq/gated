import type { components as AdminComponents } from './admin.types'
import { adminApi } from './http'

export type AdminUser = AdminComponents['schemas']['User']
export type AdminUserDataRequest = AdminComponents['schemas']['UserDataRequest']
export type AdminCreateUserRequest = AdminComponents['schemas']['CreateUserRequest']
export type AdminRole = AdminComponents['schemas']['Role']
export type AdminSessionSnapshot = AdminComponents['schemas']['SessionSnapshot']
export type AdminPaginatedSessions = AdminComponents['schemas']['PaginatedResponse_SessionSnapshot']

export async function listAdminUsers(signal?: AbortSignal): Promise<AdminUser[]> {
  return adminApi.get<AdminUser[]>('/users', signal)
}

export async function getAdminUser(id: string, signal?: AbortSignal): Promise<AdminUser> {
  return adminApi.get<AdminUser>(`/users/${encodeURIComponent(id)}`, signal)
}

export async function getAdminUserRoles(id: string, signal?: AbortSignal): Promise<AdminRole[]> {
  return adminApi.get<AdminRole[]>(`/users/${encodeURIComponent(id)}/roles`, signal)
}

export async function createAdminUser(body: AdminCreateUserRequest, signal?: AbortSignal): Promise<AdminUser> {
  return adminApi.post<AdminUser>('/users', body, signal)
}

export async function updateAdminUser(id: string, body: AdminUserDataRequest, signal?: AbortSignal): Promise<AdminUser> {
  return adminApi.put<AdminUser>(`/users/${encodeURIComponent(id)}`, body, signal)
}

export async function deleteAdminUser(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/users/${encodeURIComponent(id)}`, signal)
}

export async function listAdminSessions(params?: { active_only?: boolean, limit?: number }, signal?: AbortSignal): Promise<AdminPaginatedSessions> {
  const qs = new URLSearchParams()
  if (params?.active_only)
    qs.set('active_only', 'true')
  if (typeof params?.limit === 'number')
    qs.set('limit', String(params.limit))
  const query = qs.toString()
  return adminApi.get<AdminPaginatedSessions>(query ? `/sessions?${query}` : '/sessions', signal)
}

// User-role bindings. Backend: crates/gated-admin/src/api/users.rs.
export async function addUserRole(id: string, roleId: string, signal?: AbortSignal): Promise<void> {
  return adminApi.post<void>(`/users/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, {}, signal)
}

export async function deleteUserRole(id: string, roleId: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/users/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, signal)
}

// Password credentials. Backend: crates/gated-admin/src/api/password_credentials.rs.
export interface ExistingPasswordCredential {
  id: string
}

export async function listUserPasswordCredentials(userId: string, signal?: AbortSignal): Promise<ExistingPasswordCredential[]> {
  return adminApi.get<ExistingPasswordCredential[]>(`/users/${encodeURIComponent(userId)}/credentials/passwords`, signal)
}

export async function createUserPasswordCredential(userId: string, password: string, signal?: AbortSignal): Promise<ExistingPasswordCredential> {
  return adminApi.post<ExistingPasswordCredential>(`/users/${encodeURIComponent(userId)}/credentials/passwords`, { password }, signal)
}

export async function deleteUserPasswordCredential(userId: string, credentialId: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/users/${encodeURIComponent(userId)}/credentials/passwords/${encodeURIComponent(credentialId)}`, signal)
}
