import type { components } from './admin.types'
import { adminApi } from './http'

type Schemas = components['schemas']

export type AdminAccountSummary = Schemas['AccountSummary']
export type AdminAccountDetail = Schemas['AccountDetail']
export type AdminAccountCreate = Schemas['AccountCreate']
export type AdminAccountUpdate = Schemas['AccountUpdate']
export type AdminAccountReveal = Schemas['AccountReveal']
export type AdminAccountReference = Schemas['AccountReference']
export type RevealConfirmation = Schemas['RevealConfirmation']

export async function listAdminAccounts(signal?: AbortSignal): Promise<AdminAccountSummary[]> {
  return adminApi.get<AdminAccountSummary[]>('/accounts', signal)
}

export async function getAdminAccount(id: number, signal?: AbortSignal): Promise<AdminAccountDetail> {
  return adminApi.get<AdminAccountDetail>(`/accounts/${id}`, signal)
}

export async function createAdminAccount(body: AdminAccountCreate, signal?: AbortSignal): Promise<AdminAccountSummary> {
  return adminApi.post<AdminAccountSummary>('/accounts', body, signal)
}

export async function updateAdminAccount(id: number, body: AdminAccountUpdate, signal?: AbortSignal): Promise<AdminAccountSummary> {
  return adminApi.put<AdminAccountSummary>(`/accounts/${id}`, body, signal)
}

export async function deleteAdminAccount(id: number, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/accounts/${id}`, signal)
}

export async function listAdminAccountReferences(id: number, signal?: AbortSignal): Promise<AdminAccountReference[]> {
  return adminApi.get<AdminAccountReference[]>(`/accounts/${id}/references`, signal)
}

export async function revealAdminAccount(id: number, confirmation: RevealConfirmation, signal?: AbortSignal): Promise<AdminAccountReveal> {
  return adminApi.post<AdminAccountReveal>(`/accounts/${id}/reveal`, confirmation, signal)
}
