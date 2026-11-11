import type { components } from './admin.types'
import { adminApi, userApi } from './http'

export type AdminTicket = components['schemas']['Ticket']
export type CreateTicketRequest = components['schemas']['CreateTicketRequest']
export type TicketAndSecret = components['schemas']['TicketAndSecret']

export async function listAdminTickets(signal?: AbortSignal): Promise<AdminTicket[]> {
  return adminApi.get<AdminTicket[]>('/tickets', signal)
}

export async function createAdminTicket(body: CreateTicketRequest, signal?: AbortSignal): Promise<TicketAndSecret> {
  return adminApi.post<TicketAndSecret>('/tickets', body, signal)
}

export interface ClaimedTicket {
  target_name: string
  kind: 'Ssh' | 'MySql' | 'Postgres' | 'Http'
}

/** Signs the browser session in with a ticket; consumes one use. */
export async function claimTicket(secret: string, signal?: AbortSignal): Promise<ClaimedTicket> {
  return userApi.post<ClaimedTicket>('/tickets/claim', { secret }, signal)
}

export async function deleteAdminTicket(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/tickets/${encodeURIComponent(id)}`, signal)
}
