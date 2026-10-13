import type { AuthStateResponse } from '@/shared/lib/api/auth-requests'
import type { AuthRequest, AuthRequestState } from '@/shared/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveAuthRequest,
  listWebAuthRequests,
  rejectAuthRequest,
} from '@/shared/lib/api/auth-requests'

// Backend `protocol` is a free-form string (e.g. "ssh", "mysql", "http", "postgres", "kubernetes").
// The UI discriminator is 'ssh' | 'mysql' | 'postgres' | 'http'. Kubernetes is served by
// the HTTP protocol with a flavor distinction, so a "kubernetes" label folds
// into 'http'.
function normalizeProtocol(raw: string): AuthRequest['protocol'] {
  const v = raw.toLowerCase()
  if (v.includes('mysql'))
    return 'mysql'
  if (v.includes('postgres'))
    return 'postgres'
  if (v.includes('http') || v.includes('kubernetes') || v === 'k8s')
    return 'http'
  return 'ssh'
}

// Backend `state` distinguishes auth-flow steps; the UI collapses them to the
// approve/reject lifecycle. Anything still requesting WebUserApproval is
// pending; Success is approved; Failed is rejected; everything else is treated
// as expired/other for the history view.
function normalizeState(raw: AuthStateResponse['state']): AuthRequestState {
  if (raw === 'WebUserApprovalNeeded')
    return 'pending'
  if (raw === 'Success')
    return 'approved'
  if (raw === 'Failed')
    return 'rejected'
  return 'expired'
}

function adapt(item: AuthStateResponse): AuthRequest {
  const identification = item.identification_string
  const address = item.address ?? ''
  return {
    id: item.id,
    protocol: normalizeProtocol(item.protocol),
    target: identification || item.protocol,
    from: address,
    clientHint: identification,
    at: item.started,
    state: normalizeState(item.state),
    createdAt: item.started,
    // Backend does not expose an explicit expiry timestamp on AuthState.
    // The empty string keeps the existing AuthRequest type happy; consumer
    // pages already tolerate unparseable dates via `formatAbsolute` / NaN
    // checks and treat the countdown as expired in that case.
    expiresAt: '',
    clientIp: address || undefined,
  }
}

export function useAuthRequests() {
  return useQuery<AuthRequest[]>({
    queryKey: ['auth-requests'],
    queryFn: async ({ signal }) => {
      const list = await listWebAuthRequests(signal)
      return list.map(adapt)
    },
  })
}

export function useAuthRequestsAll() {
  return useQuery<AuthRequest[]>({
    queryKey: ['auth-requests'],
    queryFn: async ({ signal }) => {
      const list = await listWebAuthRequests(signal)
      return list.map(adapt)
    },
  })
}

export function useAuthRequestsPending() {
  return useQuery<AuthRequest[]>({
    queryKey: ['auth-requests', 'pending'],
    queryFn: async ({ signal }) => {
      // Backend's /auth/web-auth-requests already returns only pending entries
      // (see `all_pending_web_auths_for_user`). Filter defensively in case
      // semantics widen later.
      const list = await listWebAuthRequests(signal)
      return list.map(adapt).filter(item => item.state === 'pending')
    },
  })
}

export function useDecideAuthRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, decision }: { id: string, decision: 'approved' | 'rejected', decidedBy?: string }) => {
      if (decision === 'approved')
        await approveAuthRequest(id)
      else
        await rejectAuthRequest(id)
      return { id, decision }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['auth-requests'] }),
  })
}
