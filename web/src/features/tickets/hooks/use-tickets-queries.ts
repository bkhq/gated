import type { ApiError } from '@/shared/lib/api/http'
import type { AdminTicket } from '@/shared/lib/api/tickets'
import type { Ticket } from '@/shared/types/domain'
import type { TicketDraft } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useInfo, useIsAdmin } from '@/shared/hooks/use-info'
import { profileApi, ticketFromApi } from '@/shared/lib/api/profile'
import {
  createAdminTicket,
  deleteAdminTicket,
  listAdminTickets,
} from '@/shared/lib/api/tickets'
import { formatTicketExpiresIn } from '@/shared/types/domain'

function adminTicketToMock(api: AdminTicket): Ticket {
  const usesLimit = api.uses_left ?? 0
  const expiresAt = api.expiry ?? ''
  const isExpired = expiresAt !== '' && new Date(expiresAt).getTime() <= Date.now()
  const state: Ticket['state'] = isExpired ? 'expired' : 'active'
  return {
    id: api.id,
    name: api.description || api.target,
    scope: api.target,
    uses: api.uses_left == null ? 'unlimited' : `${api.uses_left} left`,
    usesLimit,
    expiresIn: state === 'active' ? formatTicketExpiresIn(expiresAt) : '—',
    expiresAt,
    issuedBy: api.username,
    issuedAt: api.created,
    purpose: api.description,
    state,
  }
}

export function useMyTickets(username: string | undefined) {
  return useQuery<Ticket[]>({
    queryKey: ['tickets', 'mine', username ?? null],
    queryFn: async ({ signal }) => profileApi.tickets.list(signal),
    enabled: typeof username === 'string',
  })
}

// Admin-only. The user surface uses `useMyTickets()` for its own ticket listing.
export function useTickets() {
  const isAdmin = useIsAdmin()
  return useQuery<Ticket[]>({
    queryKey: ['tickets'],
    queryFn: async ({ signal }) => {
      if (!isAdmin)
        return []
      const list = await listAdminTickets(signal)
      return list.map(adminTicketToMock)
    },
    enabled: isAdmin,
  })
}

export function useTicket(id: string | undefined) {
  const isAdmin = useIsAdmin()
  const qc = useQueryClient()
  return useQuery<Ticket | null>({
    queryKey: ['tickets', id ?? null],
    queryFn: async () => {
      if (!id || !isAdmin)
        return null
      const cached = qc.getQueryData<Ticket[]>(['tickets']) ?? []
      return cached.find(item => item.id === id) ?? null
    },
    enabled: typeof id === 'string' && isAdmin,
  })
}

export function useCreateTicket() {
  const isAdmin = useIsAdmin()
  const info = useInfo()
  const qc = useQueryClient()
  // The secret is returned exactly once at creation time — callers must
  // surface it immediately (share link); it cannot be fetched later.
  return useMutation<{ ticket: Ticket, secret: string }, ApiError, TicketDraft>({
    mutationFn: async (draft) => {
      const username = draft.issuedBy ?? info.data?.username ?? ''
      // Only an admin can mint a ticket on behalf of someone else; everyone
      // mints their own through the self-service endpoint.
      if (isAdmin && draft.issuedBy && draft.issuedBy !== info.data?.username) {
        const created = await createAdminTicket({
          username,
          target_name: draft.scope,
          expiry: draft.expiresAt || undefined,
          number_of_uses: draft.usesLimit > 0 ? draft.usesLimit : undefined,
          description: draft.purpose ?? '',
        })
        return { ticket: adminTicketToMock(created.ticket), secret: created.secret }
      }
      const created = await profileApi.tickets.create({
        target_name: draft.scope,
        expiry: draft.expiresAt || undefined,
        number_of_uses: draft.usesLimit > 0 ? draft.usesLimit : undefined,
        description: draft.purpose ?? '',
      })
      return { ticket: ticketFromApi(created.ticket, username), secret: created.secret }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['tickets'] }),
  })
}

export function useDeleteTicket() {
  const isAdmin = useIsAdmin()
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      // The admin endpoint reaches any ticket; the profile endpoint only the
      // caller's own, which is all a non-admin can see anyway.
      if (isAdmin)
        await deleteAdminTicket(id)
      else
        await profileApi.tickets.remove(id)
      return { id }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['tickets'] }),
  })
}

// Backend treats revoke and delete identically — both DELETE /admin/api/tickets/:id.
// Kept distinct so audit-flagged call sites (revoke confirm dialog) stay readable.
export function useRevokeTicket() {
  const isAdmin = useIsAdmin()
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      if (isAdmin)
        await deleteAdminTicket(id)
      else
        await profileApi.tickets.remove(id)
      return { id }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['tickets'] }),
  })
}
