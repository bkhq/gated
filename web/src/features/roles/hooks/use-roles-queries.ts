import type { AdminRole, AdminRoleDataRequest } from '@/shared/lib/api/roles'
import type { Role } from '@/shared/types/domain'
import type { RoleDraft, RoleReferences } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/shared/lib/api/http'
import {
  createAdminRole,
  deleteAdminRole,
  getAdminRole,
  listAdminRoles,
  listAdminRoleTargets,
  listAdminRoleUsers,
  updateAdminRole,
} from '@/shared/lib/api/roles'

function adminRoleToDomain(role: AdminRole): Role {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    allowFileTransfer: role.allow_file_transfer,
    builtin: role.builtin,
  }
}

function roleDraftToCreateRequest(draft: RoleDraft): AdminRoleDataRequest {
  return {
    name: draft.name,
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.allowFileTransfer === undefined ? {} : { allow_file_transfer: draft.allowFileTransfer }),
  }
}

function rolePatchToDataRequest(existing: AdminRole, patch: Partial<Role>): AdminRoleDataRequest {
  const name = patch.name ?? existing.name
  const description = patch.description !== undefined ? patch.description : existing.description
  const allow_file_transfer = patch.allowFileTransfer ?? existing.allow_file_transfer
  return { name, description, allow_file_transfer }
}

export function useRoles() {
  return useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: async ({ signal }) => {
      const list = await listAdminRoles(signal)
      return list.map(adminRoleToDomain)
    },
  })
}

export function useCreateRole() {
  const qc = useQueryClient()
  return useMutation<Role, ApiError, RoleDraft>({
    mutationFn: async (draft) => {
      const body = roleDraftToCreateRequest(draft)
      const created = await createAdminRole(body)
      return adminRoleToDomain(created)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['roles'] }) },
  })
}

export function useUpdateRole() {
  const qc = useQueryClient()
  return useMutation<Role | null, ApiError, { id: string, patch: Partial<Role> }>({
    mutationFn: async ({ id, patch }) => {
      const existing = await getAdminRole(id)
      const body = rolePatchToDataRequest(existing, patch)
      const updated = await updateAdminRole(id, body)
      return adminRoleToDomain(updated)
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['roles'] }) },
  })
}

export function useDeleteRole() {
  const qc = useQueryClient()
  return useMutation<{ id: string }, ApiError, string>({
    mutationFn: async (id) => {
      await deleteAdminRole(id)
      return { id }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: ['roles'] }) },
  })
}

export function useRoleReferences(id: string | undefined) {
  return useQuery<RoleReferences>({
    queryKey: ['roles', id ?? null, 'references'],
    queryFn: async ({ signal }) => {
      const empty: RoleReferences = { userCount: 0, accountCount: 0, targetCount: 0, liveSessionCount: 0, users: [] }
      if (!id)
        return empty
      try {
        const [users, targets] = await Promise.all([
          listAdminRoleUsers(id, signal).catch((err) => {
            if (err instanceof ApiError && err.status === 404)
              return []
            throw err
          }),
          listAdminRoleTargets(id, signal).catch((err) => {
            if (err instanceof ApiError && err.status === 404)
              return []
            throw err
          }),
        ])
        return {
          userCount: users.length,
          accountCount: 0,
          targetCount: targets.length,
          liveSessionCount: 0,
          users: users.map(user => user.username),
        }
      }
      catch (err) {
        if (err instanceof ApiError && err.status === 404)
          return empty
        throw err
      }
    },
    enabled: typeof id === 'string',
  })
}
