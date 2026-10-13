import type { components as AdminComponents } from './admin.types'
import type { components as UserComponents } from './user.types'
import { adminApi, userApi } from './http'

// Account binding wire shape. Backend: crates/gated-common/src/config/target.rs
// (TargetAccountRole, TargetAccountMetadata) and crates/gated-admin/src/api/targets.rs
// (TargetAccountBinding). Generated admin.types.ts lags the OpenAPI emit, so the
// fields are declared here and intersected onto the generated types below.
export type TargetAccountRole = 'primary' | 'fallback' | 'readonly'

export interface TargetAccountBinding {
  account_id: number
  role: TargetAccountRole
}

export interface TargetAccountMetadata {
  account_id: number
  account_name: string
  kind: string
  role: TargetAccountRole
}

// Admin-side schemas (full Target + CRUD payloads)
export type AdminTarget = AdminComponents['schemas']['Target'] & {
  accounts?: TargetAccountMetadata[]
}
export type AdminRole = AdminComponents['schemas']['Role']
export type AdminTargetDataRequest = AdminComponents['schemas']['TargetDataRequest'] & {
  accounts?: TargetAccountBinding[] | null
}
export type AdminTargetOptions = AdminComponents['schemas']['TargetOptions']

// User-side schema (snapshot only — no id, no host/port)
export type UserTargetSnapshot = UserComponents['schemas']['TargetSnapshot']
export type UserTargetKind = UserComponents['schemas']['TargetKind']

export async function listAdminTargets(signal?: AbortSignal): Promise<AdminTarget[]> {
  return adminApi.get<AdminTarget[]>('/targets', signal)
}

export async function getAdminTarget(id: string, signal?: AbortSignal): Promise<AdminTarget> {
  return adminApi.get<AdminTarget>(`/targets/${encodeURIComponent(id)}`, signal)
}

export async function createAdminTarget(body: AdminTargetDataRequest, signal?: AbortSignal): Promise<AdminTarget> {
  return adminApi.post<AdminTarget>('/targets', body, signal)
}

export async function updateAdminTarget(id: string, body: AdminTargetDataRequest, signal?: AbortSignal): Promise<AdminTarget> {
  return adminApi.put<AdminTarget>(`/targets/${encodeURIComponent(id)}`, body, signal)
}

export async function deleteAdminTarget(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/targets/${encodeURIComponent(id)}`, signal)
}

export async function listUserTargets(signal?: AbortSignal): Promise<UserTargetSnapshot[]> {
  return userApi.get<UserTargetSnapshot[]>('/targets', signal)
}

// Target-role bindings. Backend: crates/gated-admin/src/api/targets.rs
// (api_get_target_roles / api_add_target_role / api_delete_target_role).
export async function listTargetRoles(id: string, signal?: AbortSignal): Promise<AdminRole[]> {
  return adminApi.get<AdminRole[]>(`/targets/${encodeURIComponent(id)}/roles`, signal)
}

export async function addTargetRole(id: string, roleId: string, signal?: AbortSignal): Promise<void> {
  return adminApi.post<void>(`/targets/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, {}, signal)
}

export async function deleteTargetRole(id: string, roleId: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/targets/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, signal)
}

export type TargetKnownSshHostKey = AdminComponents['schemas']['SSHKnownHost']

export async function getTargetKnownSshHostKeys(id: string, signal?: AbortSignal): Promise<TargetKnownSshHostKey[]> {
  return adminApi.get<TargetKnownSshHostKey[]>(`/targets/${encodeURIComponent(id)}/known-ssh-host-keys`, signal)
}
