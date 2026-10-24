import type {
  AdminAccountCreate,
  AdminAccountReference,
  AdminAccountReveal,
  AdminAccountSummary,
  AdminAccountUpdate,
  RevealConfirmation,
} from '@/shared/lib/api/accounts'
import type { ApiError } from '@/shared/lib/api/http'
import type { Account, AccountCredentials, AccountKind } from '@/shared/types/domain'
import type { AccountDraft, AccountReferences, AccountSecret } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import {
  createAdminAccount,
  deleteAdminAccount,
  getAdminAccount,
  listAdminAccountReferences,
  listAdminAccounts,
  revealAdminAccount,
  updateAdminAccount,
} from '@/shared/lib/api/accounts'

function parseId(id: string): number | null {
  const n = Number.parseInt(id, 10)
  return Number.isFinite(n) ? n : null
}

const KNOWN_KINDS: readonly AccountKind[] = [
  'ssh-password',
  'ssh-key',
  'db-password',
  'k8s-token',
  'k8s-client-cert',
  'http-headers',
]

function toAccountKind(backendKind: string): AccountKind {
  return (KNOWN_KINDS as readonly string[]).includes(backendKind)
    ? (backendKind as AccountKind)
    : 'ssh-password'
}

function summaryToAccount(summary: AdminAccountSummary): Account {
  return {
    id: String(summary.id),
    name: summary.name,
    kind: toAccountKind(summary.kind),
    description: summary.description ?? '',
    referenceCount: summary.reference_count,
    lastUsed: summary.last_used_at ?? null,
    rotationDueAt: summary.rotation_due_at ?? null,
    tags: summary.tags ?? [],
  }
}

// Default (all-blank) credentials for a kind; secret fields stay blank.
export function defaultCredentialsFor(kind: AccountKind): AccountCredentials {
  switch (kind) {
    case 'ssh-password':
      return { kind, username: '', password: '' }
    case 'ssh-key':
      return { kind, username: '', private_key_pem: '', passphrase: '' }
    case 'db-password':
      return { kind, engine: 'mysql', username: '', password: '' }
    case 'k8s-token':
      return { kind, token: '', ca_pem: '', namespace: '' }
    case 'k8s-client-cert':
      return { kind, client_certificate_pem: '', client_private_key_pem: '', passphrase: '', ca_pem: '', namespace: '' }
    case 'http-headers':
      return { kind, headers: [] }
  }
}

// The detail endpoint returns stored credentials without secret values.
// Overlay them on the blank defaults so the result is a valid form draft.
export function publicToCredentials(kind: AccountKind, value: unknown): AccountCredentials {
  const base = defaultCredentialsFor(kind)
  if (value == null || typeof value !== 'object')
    return base
  const record = value as Record<string, unknown>
  if (base.kind === 'http-headers') {
    const headers = Array.isArray(record.headers) ? record.headers as Array<Record<string, unknown>> : []
    return {
      kind: 'http-headers',
      headers: headers.map(h => ({
        name: String(h.name ?? ''),
        value: typeof h.value === 'string' ? h.value : '',
        sensitive: Boolean(h.sensitive),
      })),
    }
  }
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(base)) {
    if (key !== 'kind' && typeof record[key] === 'string')
      out[key] = record[key]
  }
  return out as unknown as AccountCredentials
}

export interface AccountDetailView {
  account: Account
  credentials: AccountCredentials
}

function draftToCreate(draft: AccountDraft, confirmation?: RevealConfirmation): AdminAccountCreate {
  return {
    kind: draft.kind,
    name: draft.name,
    description: draft.description || undefined,
    credentials: draft.credentials,
    tags: draft.tags.length > 0 ? draft.tags : undefined,
    rotation_due_at: draft.rotationDueAt ?? undefined,
    confirmation,
  }
}

export interface AccountUpdateInput {
  name?: string
  description?: string
  tags?: string[]
  rotationDueAt?: string | null
  credentials?: AccountCredentials
}

function patchToUpdate(patch: AccountUpdateInput, confirmation?: RevealConfirmation): AdminAccountUpdate {
  const body: AdminAccountUpdate = { confirmation }
  if (patch.name !== undefined)
    body.name = patch.name
  if (patch.description !== undefined)
    body.description = patch.description
  if (patch.tags !== undefined)
    body.tags = patch.tags
  if (patch.rotationDueAt === null)
    body.clear_rotation_due_at = true
  else if (patch.rotationDueAt !== undefined)
    body.rotation_due_at = patch.rotationDueAt
  if (patch.credentials !== undefined)
    body.credentials = patch.credentials
  return body
}

function referencesToUi(refs: AdminAccountReference[]): AccountReferences {
  return {
    targetCount: refs.length,
    roleCount: 0,
    targetNames: refs.map(r => r.target_name),
    roles: [],
  }
}

function revealToSecret(reveal: AdminAccountReveal): AccountSecret | null {
  if (reveal.credentials == null || typeof reveal.credentials !== 'object')
    return null
  const credentials = reveal.credentials
  return { kind: credentials.kind, credentials }
}

export function useAccounts() {
  return useQuery<Account[]>({
    queryKey: ['accounts'],
    queryFn: async ({ signal }) => (await listAdminAccounts(signal)).map(summaryToAccount),
  })
}

export function useAccount(id: string | undefined) {
  return useQuery<AccountDetailView | null>({
    queryKey: ['accounts', id ?? null],
    queryFn: async ({ signal }) => {
      const n = id != null ? parseId(id) : null
      if (n == null)
        return null
      const detail = await getAdminAccount(n, signal)
      const account = summaryToAccount(detail)
      return { account, credentials: publicToCredentials(account.kind, detail.credentials_public) }
    },
    enabled: typeof id === 'string',
  })
}

export function useCreateAccount() {
  const qc = useQueryClient()
  return useMutation<Account, ApiError, { draft: AccountDraft, confirmation?: RevealConfirmation }>({
    mutationFn: async ({ draft, confirmation }) => {
      const created = await createAdminAccount(draftToCreate(draft, confirmation))
      return summaryToAccount(created)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['accounts'] }) },
  })
}

export function useUpdateAccount() {
  const qc = useQueryClient()
  return useMutation<Account | null, ApiError, { id: string, patch: AccountUpdateInput, confirmation?: RevealConfirmation }>({
    mutationFn: async ({ id, patch, confirmation }) => {
      const n = parseId(id)
      if (n == null)
        return null
      const updated = await updateAdminAccount(n, patchToUpdate(patch, confirmation))
      return summaryToAccount(updated)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['accounts'] }) },
  })
}

export function useDeleteAccount() {
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      const n = parseId(id)
      if (n != null)
        await deleteAdminAccount(n)
      return { id }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['accounts'] }) },
  })
}

export function useAccountReferences(id: string | undefined) {
  return useQuery<AccountReferences>({
    queryKey: ['accounts', id ?? null, 'references'],
    queryFn: async ({ signal }) => {
      const n = id != null ? parseId(id) : null
      if (n == null)
        return { targetCount: 0, roleCount: 0, targetNames: [], roles: [] }
      return referencesToUi(await listAdminAccountReferences(n, signal))
    },
    enabled: typeof id === 'string',
  })
}

// Keep confirmation and revealed credentials out of the shared mutation cache.
export function useRevealAccountSecret() {
  const [data, setData] = React.useState<AccountSecret | null>(null)
  const [error, setError] = React.useState<Error | null>(null)
  const [isPending, setIsPending] = React.useState(false)
  const controllerRef = React.useRef<AbortController | null>(null)
  const reset = React.useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setData(null)
    setError(null)
    setIsPending(false)
  }, [])
  React.useEffect(() => () => controllerRef.current?.abort(), [])
  React.useEffect(() => {
    if (!data)
      return
    const timer = setTimeout(reset, 60_000)
    return () => clearTimeout(timer)
  }, [data, reset])
  const mutateAsync = async ({ id, confirmation }: { id: string, confirmation: RevealConfirmation }) => {
    reset()
    const n = parseId(id)
    if (n == null)
      return
    const request = new AbortController()
    controllerRef.current = request
    setIsPending(true)
    try {
      const result = await revealAdminAccount(n, confirmation, request.signal)
      if (!request.signal.aborted)
        setData(revealToSecret(result))
    }
    catch (failure) {
      if (!request.signal.aborted) {
        setError(failure instanceof Error ? failure : new Error(String(failure)))
        // Let the step-up prompt show the failure and stay open for a retry.
        throw failure
      }
    }
    finally {
      if (!request.signal.aborted)
        setIsPending(false)
    }
  }
  return { data, error, isPending, mutateAsync, reset }
}
