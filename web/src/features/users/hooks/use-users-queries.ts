import type { AdminUser, AdminUserDataRequest } from '@/shared/lib/api/users'
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
  updateAdminUser,
} from '@/shared/lib/api/users'

function adminUserToMock(user: AdminUser): User {
  const mock: User = {
    id: user.id,
    username: user.username,
    name: user.description || user.username,
    description: user.description,
    roles: [],
  }
  if (user.rate_limit_bytes_per_second != null)
    mock.rate_limit_bytes_per_second = user.rate_limit_bytes_per_second
  return mock
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
  return body
}

export function useUsers() {
  return useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async ({ signal }) => {
      const list = await listAdminUsers(signal)
      return list.map(adminUserToMock)
    },
  })
}

export function useUser(id: string | undefined) {
  return useQuery<User | null>({
    queryKey: ['users', id ?? null],
    queryFn: async ({ signal }) => {
      if (!id)
        return null
      try {
        const [user, roles] = await Promise.all([
          getAdminUser(id, signal),
          getAdminUserRoles(id, signal).catch(() => []),
        ])
        const mock = adminUserToMock(user)
        mock.roles = roles.map(role => role.name)
        return mock
      }
      catch (err) {
        if (err instanceof ApiError && err.status === 404)
          return null
        throw err
      }
    },
    enabled: typeof id === 'string',
  })
}

// Reconcile user-role bindings to the desired set (role ids).
async function syncUserRoles(userId: string, desiredRoleIds: string[]): Promise<void> {
  const current = await getAdminUserRoles(userId)
  const currentIds = new Set(current.map(role => role.id))
  const desired = new Set(desiredRoleIds)
  await Promise.all([
    ...desiredRoleIds.filter(id => !currentIds.has(id)).map(async id => addUserRole(userId, id)),
    ...current.filter(role => !desired.has(role.id)).map(async role => deleteUserRole(userId, role.id)),
  ])
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
  return useMutation<User, ApiError, UserDraft & { roleIds?: string[], password?: string }>({
    mutationFn: async ({ roleIds, password, ...draft }) => {
      const body = userDraftToCreateRequest(draft)
      const created = await createAdminUser(body)
      if (password)
        await createUserPasswordCredential(created.id, password)
      if (roleIds && roleIds.length > 0)
        await syncUserRoles(created.id, roleIds)
      return adminUserToMock(created)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['users'] }) },
  })
}

export function useUpdateUser() {
  const qc = useQueryClient()
  return useMutation<User | null, ApiError, { id: string, patch: Partial<User>, roleIds?: string[] }>({
    mutationFn: async ({ id, patch, roleIds }) => {
      const existing = await getAdminUser(id)
      const body = userPatchToDataRequest(existing, patch)
      const updated = await updateAdminUser(id, body)
      if (roleIds)
        await syncUserRoles(id, roleIds)
      return adminUserToMock(updated)
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
