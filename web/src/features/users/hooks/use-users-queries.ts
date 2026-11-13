import type { AdminUser, AdminUserDataRequest, AdminUserListItem } from '@/shared/lib/api/users'
import type { User } from '@/shared/types/domain'
import type { UserDraft, UserReferences } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/shared/lib/api/http'
import {
  addUserRole,
  createAdminUser,
  createUserPasswordCredential,
  deleteAdminUser,
  deleteUserPasswordCredential,
  deleteUserRole,
  getAdminUser,
  getAdminUserRoles,
  listAdminSessions,
  listAdminUsers,
  listUserPasswordCredentials,
  setUserRoleExpiry,
  updateAdminUser,
} from '@/shared/lib/api/users'

function adminUserToDomain(user: AdminUser | AdminUserListItem): User {
  const result: User = {
    id: user.id,
    username: user.username,
    name: user.description || user.username,
    description: user.description,
    roles: 'roles' in user ? user.roles : [],
  }
  if (user.rate_limit_bytes_per_second != null)
    result.rate_limit_bytes_per_second = user.rate_limit_bytes_per_second
  if (user.allowed_ip_ranges != null)
    result.allowed_ip_ranges = user.allowed_ip_ranges
  return result
}

function userDraftToCreateRequest(draft: UserDraft): { username: string, description?: string } {
  const description = draft.name && draft.name !== draft.username ? draft.name : undefined
  return description === undefined
    ? { username: draft.username }
    : { username: draft.username, description }
}

function userPatchToDataRequest(existing: AdminUser, patch: Partial<User>): AdminUserDataRequest {
  const username = patch.username ?? existing.username
  const description = patch.name !== undefined
    ? patch.name
    : existing.description
  const body: AdminUserDataRequest = { username, description }
  if (existing.credential_policy !== undefined)
    body.credential_policy = existing.credential_policy
  if (existing.rate_limit_bytes_per_second !== undefined)
    body.rate_limit_bytes_per_second = existing.rate_limit_bytes_per_second
  // The update replaces the list, so an untouched one is sent back as it is.
  body.allowed_ip_ranges = patch.allowed_ip_ranges ?? existing.allowed_ip_ranges
  return body
}

export function useUsers() {
  return useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async ({ signal }) => {
      const list = await listAdminUsers(signal)
      return list.map(adminUserToDomain)
    },
  })
}

/** Expiry per role id, as an ISO time; `null` = never. A role left out keeps its expiry. */
export type RoleExpiry = Record<string, string | null>

function sameInstant(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : new Date(a).getTime() === new Date(b).getTime()
}

// Reconcile user-role bindings to the desired set (role ids), then the
// expiries that differ from what is stored.
async function syncUserRoles(userId: string, desiredRoleIds: string[], roleExpiry: RoleExpiry = {}): Promise<void> {
  const current = await getAdminUserRoles(userId)
  const stored = new Map(current.map(role => [role.id, role.expires_at ?? null]))
  const desired = new Set(desiredRoleIds)
  await Promise.all([
    ...desiredRoleIds.filter(id => !stored.has(id)).map(async id => addUserRole(userId, id)),
    ...current.filter(role => !desired.has(role.id)).map(async role => deleteUserRole(userId, role.id)),
  ])
  // A new assignment is permanent until told otherwise.
  const changed = desiredRoleIds.filter(id => id in roleExpiry && !sameInstant(roleExpiry[id] ?? null, stored.get(id) ?? null))
  await Promise.all(changed.map(async id => setUserRoleExpiry(userId, id, roleExpiry[id] ?? null)))
}

export function useUserRoles(userId: string | undefined) {
  return useQuery({
    queryKey: ['users', userId ?? null, 'roles'],
    queryFn: async ({ signal }) => getAdminUserRoles(userId as string, signal),
    enabled: typeof userId === 'string' && userId.length > 0,
  })
}

export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation<User, ApiError, UserDraft & { roleIds?: string[], roleExpiry?: RoleExpiry, password?: string }>({
    mutationFn: async ({ roleIds, roleExpiry, password, ...draft }) => {
      const body = userDraftToCreateRequest(draft)
      const created = await createAdminUser(body)
      if (password)
        await createUserPasswordCredential(created.id, password)
      if (roleIds && roleIds.length > 0)
        await syncUserRoles(created.id, roleIds, roleExpiry)
      return adminUserToDomain(created)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['users'] }) },
  })
}

export function useUpdateUser() {
  const qc = useQueryClient()
  return useMutation<User | null, ApiError, { id: string, patch: Partial<User>, roleIds?: string[], roleExpiry?: RoleExpiry }>({
    mutationFn: async ({ id, patch, roleIds, roleExpiry }) => {
      const existing = await getAdminUser(id)
      const body = userPatchToDataRequest(existing, patch)
      const updated = await updateAdminUser(id, body)
      if (roleIds)
        await syncUserRoles(id, roleIds, roleExpiry)
      return adminUserToDomain(updated)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['users'] }) },
  })
}

// Reset = replace: drop all existing password credentials, then create the
// new one (backend POST always inserts a new credential row).
export function useSetUserPassword() {
  const qc = useQueryClient()
  return useMutation<void, ApiError, { userId: string, password: string }>({
    mutationFn: async ({ userId, password }) => {
      const existing = await listUserPasswordCredentials(userId)
      await Promise.all(existing.map(async cred => deleteUserPasswordCredential(userId, cred.id)))
      await createUserPasswordCredential(userId, password)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['users'] }) },
  })
}

export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      await deleteAdminUser(id)
      return { id }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['users'] }) },
  })
}

interface BulkResult<T> {
  ids: string[]
  succeeded: string[]
  failed: { id: string, error: unknown }[]
  extra?: T
}

export function useBulkDeleteUsers() {
  const qc = useQueryClient()
  return useMutation<BulkResult<undefined>, ApiError, string[]>({
    mutationFn: async (ids) => {
      const settled = await Promise.allSettled(ids.map(async (id) => {
        await deleteAdminUser(id)
        return id
      }))
      const succeeded: string[] = []
      const failed: { id: string, error: unknown }[] = []
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index]!
        const result = settled[index]!
        if (result.status === 'fulfilled')
          succeeded.push(id)
        else
          failed.push({ id, error: result.reason })
      }
      return { ids, succeeded, failed }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['users'] }) },
  })
}

export function useUserReferences(id: string | undefined) {
  return useQuery<UserReferences>({
    queryKey: ['users', id ?? null, 'references'],
    queryFn: async ({ signal }) => {
      if (!id)
        return { roleCount: 0, liveSessionCount: 0, roles: [] }
      try {
        const [user, roles, sessions] = await Promise.all([
          getAdminUser(id, signal),
          getAdminUserRoles(id, signal).catch(() => []),
          listAdminSessions({ active_only: true, limit: 500 }, signal).catch(() => ({ items: [], offset: 0, total: 0 })),
        ])
        const roleNames = roles.map(role => role.name)
        const liveSessionCount = sessions.items.filter(session => session.username === user.username).length
        return { roleCount: roleNames.length, liveSessionCount, roles: roleNames }
      }
      catch (err) {
        if (err instanceof ApiError && err.status === 404)
          return { roleCount: 0, liveSessionCount: 0, roles: [] }
        throw err
      }
    },
    enabled: typeof id === 'string',
  })
}
