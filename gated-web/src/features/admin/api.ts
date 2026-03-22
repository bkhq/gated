// TanStack Query hooks for the admin API

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, stringifyError, type CreateUserRequest, type UserDataRequest, type NewPasswordCredential, type NewSsoCredential, type NewPublicKeyCredential, type RoleDataRequest, type ParameterUpdate } from '@/features/admin/lib/api'

export const adminKeys = {
  sessions: ['admin', 'sessions'] as const,
  session: (id: string) => ['admin', 'sessions', id] as const,
  recordings: ['admin', 'recordings'] as const,
  recording: (id: string) => ['admin', 'recordings', id] as const,
  targets: ['admin', 'targets'] as const,
  target: (id: string) => ['admin', 'targets', id] as const,
  users: ['admin', 'users'] as const,
  user: (id: string) => ['admin', 'users', id] as const,
  userRoles: (id: string) => ['admin', 'users', id, 'roles'] as const,
  userPasswordCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'passwords'] as const,
  userSsoCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'sso'] as const,
  userPublicKeyCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'public-keys'] as const,
  roles: ['admin', 'roles'] as const,
  role: (id: string) => ['admin', 'roles', id] as const,
  tickets: ['admin', 'tickets'] as const,
  sshKeys: ['admin', 'ssh-keys'] as const,
  knownHosts: ['admin', 'known-hosts'] as const,
  parameters: ['admin', 'parameters'] as const,
  logs: ['admin', 'logs'] as const,
  ldapServers: ['admin', 'ldap-servers'] as const,
  ldapServer: (id: string) => ['admin', 'ldap-servers', id] as const,
  targetGroups: ['admin', 'target-groups'] as const,
  targetGroup: (id: string) => ['admin', 'target-groups', id] as const,
}

// ============================================================
// Users
// ============================================================

export function useUsers(search?: string) {
  return useQuery({
    queryKey: search ? [...adminKeys.users, { search }] : adminKeys.users,
    queryFn: () => api.getUsers(search),
  })
}

export function useUser(id: string) {
  return useQuery({
    queryKey: adminKeys.user(id),
    queryFn: () => api.getUser(id),
    enabled: !!id,
  })
}

export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: CreateUserRequest) => api.createUser(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users })
    },
  })
}

export function useUpdateUser(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: UserDataRequest) => api.updateUser(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.user(id) })
    },
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users })
    },
  })
}

// ============================================================
// User Roles
// ============================================================

export function useUserRoles(userId: string) {
  return useQuery({
    queryKey: adminKeys.userRoles(userId),
    queryFn: () => api.getUserRoles(userId),
    enabled: !!userId,
  })
}

export function useAddUserRole(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (roleId: string) => api.addUserRole(userId, roleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userRoles(userId) })
    },
  })
}

export function useDeleteUserRole(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (roleId: string) => api.deleteUserRole(userId, roleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userRoles(userId) })
    },
  })
}

// ============================================================
// User Credentials - Passwords
// ============================================================

export function usePasswordCredentials(userId: string) {
  return useQuery({
    queryKey: adminKeys.userPasswordCredentials(userId),
    queryFn: () => api.getPasswordCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreatePasswordCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: NewPasswordCredential) => api.createPasswordCredential(userId, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userPasswordCredentials(userId) })
    },
  })
}

export function useDeletePasswordCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deletePasswordCredential(userId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userPasswordCredentials(userId) })
    },
  })
}

// ============================================================
// User Credentials - SSO
// ============================================================

export function useSsoCredentials(userId: string) {
  return useQuery({
    queryKey: adminKeys.userSsoCredentials(userId),
    queryFn: () => api.getSsoCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreateSsoCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: NewSsoCredential) => api.createSsoCredential(userId, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userSsoCredentials(userId) })
    },
  })
}

export function useDeleteSsoCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSsoCredential(userId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userSsoCredentials(userId) })
    },
  })
}

// ============================================================
// User Credentials - Public Keys
// ============================================================

export function usePublicKeyCredentials(userId: string) {
  return useQuery({
    queryKey: adminKeys.userPublicKeyCredentials(userId),
    queryFn: () => api.getPublicKeyCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreatePublicKeyCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: NewPublicKeyCredential) => api.createPublicKeyCredential(userId, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userPublicKeyCredentials(userId) })
    },
  })
}

export function useDeletePublicKeyCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deletePublicKeyCredential(userId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userPublicKeyCredentials(userId) })
    },
  })
}

// ============================================================
// Roles (for role assignment in user detail)
// ============================================================

export function useRoles(search?: string) {
  return useQuery({
    queryKey: search ? [...adminKeys.roles, { search }] : adminKeys.roles,
    queryFn: () => api.getRoles(search),
  })
}

export function useCreateRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: RoleDataRequest) => api.createRole(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.roles })
    },
  })
}

// ============================================================
// Parameters
// ============================================================

export function useParametersQuery() {
  return useQuery({
    queryKey: adminKeys.parameters,
    queryFn: () => api.getParameters(),
  })
}

export function useUpdateParametersMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: ParameterUpdate) => api.updateParameters(req),
    onSuccess: (data) => {
      queryClient.setQueryData(adminKeys.parameters, data)
    },
  })
}

export { stringifyError }
