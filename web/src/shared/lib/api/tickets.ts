import type { components } from './admin.types'
import { adminApi } from './http'

export type AdminTicket = components['schemas']['Ticket']
export type CreateTicketRequest = components['schemas']['CreateTicketRequest']
export type TicketAndSecret = components['schemas']['TicketAndSecret']

export async function listAdminTickets(signal?: AbortSignal): Promise<AdminTicket[]> {
  return adminApi.get<AdminTicket[]>('/tickets', signal)
}

export async function createAdminTicket(body: CreateTicketRequest, signal?: AbortSignal): Promise<TicketAndSecret> {
  return adminApi.post<TicketAndSecret>('/tickets', body, signal)
}

export async function deleteAdminTicket(id: string, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/tickets/${encodeURIComponent(id)}`, signal)
}
