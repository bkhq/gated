import type {
  AdminTarget,
  AdminTargetDataRequest,
  AdminTargetOptions,
  TargetAccountMetadata,
  UserTargetKind,
  UserTargetSnapshot,
} from '@/shared/lib/api/targets'
import type { LiveSession, Target, TargetKind } from '@/shared/types/domain'
import type { InlineAuth, TargetDraft } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useIsAdmin } from '@/shared/hooks/use-info'
import { ApiError } from '@/shared/lib/api/http'
import { listTargetGroups } from '@/shared/lib/api/target-groups'
import {
  addTargetRole,
  createAdminTarget,
  deleteAdminTarget,
  deleteTargetRole,
  getAdminTarget,
  listAdminTargets,
  listTargetRoles,
  listUserTargets,
  updateAdminTarget,
} from '@/shared/lib/api/targets'

export type TargetWithAccounts = Target & { accounts?: TargetAccountMetadata[], inlineAuth?: InlineAuth }

function apiKindToMockKind(kind: AdminTargetOptions['kind'] | UserTargetKind): TargetKind {
  switch (kind) {
    case 'Ssh': return 'ssh'
    case 'MySql': return 'mysql'
    case 'Postgres': return 'postgres'
    case 'Http': return 'http'
    default: return 'ssh'
  }
}

function extractEndpoint(options: AdminTargetOptions): { host: string, port: number, user: string } {
  switch (options.kind) {
    case 'Ssh':
    case 'MySql':
    case 'Postgres':
      return { host: options.host, port: options.port, user: options.username }
    case 'Http':
      return { host: options.url, port: 0, user: '' }
    default:
      return { host: '', port: 0, user: '' }
  }
}

async function listGroupNames(signal?: AbortSignal): Promise<Map<string, string>> {
  const groups = await listTargetGroups(signal)
  return new Map(groups.map(group => [group.id, group.name]))
}

// Mutation results skip the group lookup; the list is refetched on success.
function adminTargetToMock(target: AdminTarget, groupNames = new Map<string, string>()): TargetWithAccounts {
  const { host, port, user } = extractEndpoint(target.options)
  const readonly = (target.options.kind === 'MySql' || target.options.kind === 'Postgres')
    ? !!target.options.readonly
    : false
  return {
    id: target.id,
    name: target.name,
    kind: apiKindToMockKind(target.options.kind),
    host,
    port,
    user,
    group: target.group_id ?? '',
    groupName: target.group_id ? groupNames.get(target.group_id) ?? '' : '',
    description: target.description,
    readonly,
    flavor: target.options.kind === 'Http' ? target.options.flavor : undefined,
    tls: target.options.kind === 'Ssh' ? undefined : target.options.tls,
    accounts: target.accounts,
    inlineAuth: inlineAuthFromOptions(target.options),
  }
}

// Read endpoints return inline credentials with blank secrets; only the
// method survives.
function inlineAuthFromOptions(options: AdminTargetOptions): InlineAuth {
  switch (options.kind) {
    case 'Ssh':
      return options.auth.kind === 'PublicKey'
        ? { method: 'key', privateKey: '', passphrase: '' }
        : { method: 'password', password: '' }
    case 'Http':
      return (options.upstream_auth as { kind?: string }).kind === 'BearerToken'
        ? { method: 'bearer', token: '' }
        : { method: 'none' }
    case 'MySql':
    case 'Postgres':
      return { method: 'password', password: '' }
  }
}

function userSnapshotToMock(snapshot: UserTargetSnapshot): Target {
  return {
    id: snapshot.name,
    name: snapshot.name,
    kind: apiKindToMockKind(snapshot.kind),
    host: '',
    port: 0,
    user: '',
    group: snapshot.group?.id ?? '',
    groupName: snapshot.group?.name ?? '',
    description: snapshot.description,
    readonly: false,
  }
}

function mockKindToOptions(draft: Pick<TargetDraft, 'kind' | 'host' | 'port' | 'user' | 'flavor' | 'readonly' | 'inlineAuth'>): AdminTargetOptions {
  const auth = draft.inlineAuth
  const password = auth?.method === 'password' && auth.password ? auth.password : undefined
  switch (draft.kind) {
    case 'ssh':
      return {
        kind: 'Ssh',
        host: draft.host,
        port: draft.port,
        username: draft.user,
        auth: auth?.method === 'key'
          ? { kind: 'PublicKey', private_key_pem: auth.privateKey || undefined, passphrase: auth.passphrase || undefined }
          : { kind: 'Password', password: password ?? '' },
      }
    case 'mysql':
      return {
        kind: 'MySql',
        host: draft.host,
        port: draft.port,
        username: draft.user,
        password,
        tls: { mode: 'Preferred', verify: false },
        readonly: !!draft.readonly,
      }
    case 'postgres':
      return {
        kind: 'Postgres',
        host: draft.host,
        port: draft.port,
        username: draft.user,
        password,
        tls: { mode: 'Preferred', verify: false },
        readonly: !!draft.readonly,
      }
    case 'http': {
      // draft.host holds the full upstream URL for HTTP targets (the form
      // shows a URL field). Preserve the user's scheme; only prepend a
      // default when none was given.
      const url = /^https?:\/\//i.test(draft.host) ? draft.host : `https://${draft.host}`
      // TLS mode must match the scheme: an http:// upstream with
      // tls.mode=Required is rejected by the backend.
      const isHttps = url.toLowerCase().startsWith('https://')
      return {
        kind: 'Http',
        url,
        tls: { mode: isHttps ? 'Required' : 'Disabled', verify: false },
        upstream_auth: auth?.method === 'bearer' ? { kind: 'BearerToken', token: auth.token } : { kind: 'None' },
        flavor: draft.flavor ?? 'generic',
      }
    }
    default:
      throw new ApiError(400, `Unsupported target kind: ${String(draft.kind)}`, null)
  }
}

function mockDraftToApiRequest(draft: TargetDraft): AdminTargetDataRequest {
  const accounts = draft.accounts?.map(a => ({
    account_id: a.account_id,
    role: a.role,
  }))
  return {
    name: draft.name,
    description: draft.description || undefined,
    options: mockKindToOptions(draft),
    accounts,
    group_id: draft.group || undefined,
  }
}

// Reconcile target-role bindings to the desired set (role ids).
async function syncTargetRoles(targetId: string, desiredRoleIds: string[]): Promise<void> {
  const current = await listTargetRoles(targetId)
  const currentIds = new Set(current.map(role => role.id))
  const desired = new Set(desiredRoleIds)
  await Promise.all([
    ...desiredRoleIds.filter(id => !currentIds.has(id)).map(async id => addTargetRole(targetId, id)),
    ...current.filter(role => !desired.has(role.id)).map(async role => deleteTargetRole(targetId, role.id)),
  ])
}

export function useTargetRoles(targetId: string | undefined) {
  return useQuery({
    queryKey: ['targets', targetId ?? null, 'roles'],
    queryFn: async ({ signal }) => listTargetRoles(targetId as string, signal),
    enabled: typeof targetId === 'string' && targetId.length > 0,
  })
}

export function useTargets() {
  const isAdmin = useIsAdmin()
  return useQuery<Target[]>({
    queryKey: ['targets'],
    queryFn: async ({ signal }) => {
      if (isAdmin) {
        const [list, groupNames] = await Promise.all([listAdminTargets(signal), listGroupNames(signal)])
        return list.map(target => adminTargetToMock(target, groupNames))
      }
      const list = await listUserTargets(signal)
      return list.map(userSnapshotToMock)
    },
  })
}

export function useFrequentTargets(limit: number = 5) {
  const qc = useQueryClient()
  const targetsQuery = useTargets()
  return useQuery<Target[]>({
    queryKey: ['targets', 'frequent', limit],
    queryFn: async () => {
      const targets = targetsQuery.data ?? qc.getQueryData<Target[]>(['targets']) ?? []
      if (targets.length === 0)
        return []
      const mine = qc.getQueryData<LiveSession[]>(['sessions', 'mine']) ?? []
      const counts = new Map<string, number>()
      for (const session of mine) {
        const key = session.target
        if (typeof key === 'string')
          counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      if (counts.size === 0)
        return targets.slice(0, limit)
      return [...targets]
        .sort((a, b) => (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0))
        .slice(0, limit)
    },
    enabled: !targetsQuery.isLoading,
  })
}

export function useTarget(id: string | undefined) {
  const isAdmin = useIsAdmin()
  const qc = useQueryClient()
  return useQuery<TargetWithAccounts | null>({
    queryKey: ['targets', id ?? null],
    queryFn: async ({ signal }) => {
      if (!id)
        return null
      if (isAdmin) {
        const [target, groupNames] = await Promise.all([getAdminTarget(id, signal), listGroupNames(signal)])
        return adminTargetToMock(target, groupNames)
      }
      const cached = qc.getQueryData<Target[]>(['targets']) ?? []
      return cached.find(item => item.id === id) ?? null
    },
    enabled: typeof id === 'string',
  })
}

export function useCreateTarget() {
  const qc = useQueryClient()
  return useMutation<Target, ApiError, TargetDraft & { roleIds?: string[] }>({
    mutationFn: async ({ roleIds, ...draft }) => {
      const req = mockDraftToApiRequest(draft)
      const created = await createAdminTarget(req)
      if (roleIds && roleIds.length > 0)
        await syncTargetRoles(created.id, roleIds)
      return adminTargetToMock(created)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['targets'] }) },
  })
}

export function useUpdateTarget() {
  const qc = useQueryClient()
  return useMutation<Target | null, ApiError, { id: string, patch: Partial<TargetDraft>, roleIds?: string[] }>({
    mutationFn: async ({ id, patch, roleIds }) => {
      const existing = await getAdminTarget(id)
      const merged: TargetDraft = {
        ...adminTargetToMock(existing),
        ...patch,
        name: patch.name ?? existing.name,
      }
      const req = mockDraftToApiRequest(merged)
      const updated = await updateAdminTarget(id, req)
      if (roleIds)
        await syncTargetRoles(id, roleIds)
      return adminTargetToMock(updated)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['targets'] }) },
  })
}

export function useDeleteTarget() {
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      await deleteAdminTarget(id)
      return { id }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['targets'] }) },
  })
}
