// TanStack Query hooks for the admin API

import type { CreateLdapServerRequest, CreateTicketRequest, CreateUserRequest, GetLogsRequest, ImportLdapUsersRequest, IssueCertificateCredentialRequest, NewOtpCredential, NewPasswordCredential, NewPublicKeyCredential, NewSsoCredential, ParameterUpdate, RoleDataRequest, TargetDataRequest, TargetGroupDataRequest, TestLdapServerRequest, UpdateCertificateCredential, UpdateLdapServerRequest, UserDataRequest } from '@/features/admin/lib/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { toast } from 'sonner'
import { api, ResponseError, stringifyError } from '@/features/admin/lib/api'

function handleMutationError(err: unknown): void {
  if (err instanceof ResponseError) {
    void err.response.text().then(text => toast.error(`API error: ${text}`))
  }
  else if (err instanceof Error) {
    toast.error(err.message)
  }
}

export const adminKeys = {
  sessions: (activeOnly?: boolean) => ['admin', 'sessions', { activeOnly }] as const,
  session: (id: string) => ['admin', 'sessions', id] as const,
  sessionRecordings: (id: string) => ['admin', 'sessions', id, 'recordings'] as const,
  recordings: ['admin', 'recordings'] as const,
  recording: (id: string) => ['admin', 'recordings', id] as const,
  recordingCast: (id: string) => ['admin', 'recordings', id, 'cast'] as const,
  targets: ['admin', 'targets'] as const,
  target: (id: string) => ['admin', 'targets', id] as const,
  users: ['admin', 'users'] as const,
  user: (id: string) => ['admin', 'users', id] as const,
  userRoles: (id: string) => ['admin', 'users', id, 'roles'] as const,
  userPasswordCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'passwords'] as const,
  userSsoCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'sso'] as const,
  userPublicKeyCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'public-keys'] as const,
  userOtpCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'otp'] as const,
  userCertCredentials: (id: string) => ['admin', 'users', id, 'credentials', 'certificates'] as const,
  roles: ['admin', 'roles'] as const,
  role: (id: string) => ['admin', 'roles', id] as const,
  roleUsers: (id: string) => ['admin', 'roles', id, 'users'] as const,
  roleTargets: (id: string) => ['admin', 'roles', id, 'targets'] as const,
  tickets: ['admin', 'tickets'] as const,
  sshKeys: ['admin', 'ssh-keys'] as const,
  knownHosts: ['admin', 'known-hosts'] as const,
  parameters: ['admin', 'parameters'] as const,
  logs: ['admin', 'logs'] as const,
  ldapServers: ['admin', 'ldap-servers'] as const,
  ldapServer: (id: string) => ['admin', 'ldap-servers', id] as const,
  ldapUsers: (id: string) => ['admin', 'ldap-servers', id, 'users'] as const,
  targetGroups: ['admin', 'target-groups'] as const,
  targetGroup: (id: string) => ['admin', 'target-groups', id] as const,
  targetsByGroup: (groupId: string) => ['admin', 'targets', 'by-group', groupId] as const,
}

// ============================================================
// Sessions
// ============================================================

export function useSessionsQuery(activeOnly?: boolean) {
  return useQuery({
    queryKey: adminKeys.sessions(activeOnly),
    queryFn: async () => api.getSessions({ active_only: activeOnly }),
  })
}

export function useSessionQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.session(id),
    queryFn: async () => api.getSession(id),
    enabled: !!id,
  })
}

export function useSessionRecordingsQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.sessionRecordings(id),
    queryFn: async () => api.getSessionRecordings(id),
    enabled: !!id,
  })
}

export function useCloseSessionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.closeSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sessions'] })
    },
  })
}

export function useCleanSessionsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => api.closeAllSessions(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sessions'] })
    },
  })
}

// ============================================================
// Recordings
// ============================================================

export function useRecordingQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.recording(id),
    queryFn: async () => api.getRecording(id),
    enabled: !!id,
  })
}

export function useRecordingCastQuery(id: string, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.recordingCast(id),
    queryFn: async () => api.getRecordingCast(id),
    enabled: !!id && enabled,
  })
}

// ============================================================
// Users
// ============================================================

export function useUsers(search?: string) {
  return useQuery({
    queryKey: search != null && search !== '' ? [...adminKeys.users, { search }] : adminKeys.users,
    queryFn: async () => api.getUsers(search),
  })
}

export function useUser(id: string) {
  return useQuery({
    queryKey: adminKeys.user(id),
    queryFn: async () => api.getUser(id),
    enabled: !!id,
  })
}

export function useCreateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: CreateUserRequest) => api.createUser(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.users })
    },
  })
}

export function useUpdateUser(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: UserDataRequest) => api.updateUser(id, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.user(id) })
    },
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.users })
    },
  })
}

// ============================================================
// User Roles
// ============================================================

export function useUserRoles(userId: string) {
  return useQuery({
    queryKey: adminKeys.userRoles(userId),
    queryFn: async () => api.getUserRoles(userId),
    enabled: !!userId,
  })
}

export function useAddUserRole(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (roleId: string) => api.addUserRole(userId, roleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userRoles(userId) })
    },
  })
}

export function useDeleteUserRole(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (roleId: string) => api.deleteUserRole(userId, roleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userRoles(userId) })
    },
  })
}

// ============================================================
// User Credentials - Passwords
// ============================================================

export function usePasswordCredentials(userId: string) {
  return useQuery({
    queryKey: adminKeys.userPasswordCredentials(userId),
    queryFn: async () => api.getPasswordCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreatePasswordCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: NewPasswordCredential) => api.createPasswordCredential(userId, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userPasswordCredentials(userId) })
    },
  })
}

export function useDeletePasswordCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deletePasswordCredential(userId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userPasswordCredentials(userId) })
    },
  })
}

// ============================================================
// User Credentials - SSO
// ============================================================

export function useSsoCredentials(userId: string) {
  return useQuery({
    queryKey: adminKeys.userSsoCredentials(userId),
    queryFn: async () => api.getSsoCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreateSsoCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: NewSsoCredential) => api.createSsoCredential(userId, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userSsoCredentials(userId) })
    },
  })
}

export function useDeleteSsoCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteSsoCredential(userId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userSsoCredentials(userId) })
    },
  })
}

// ============================================================
// User Credentials - Public Keys
// ============================================================

export function usePublicKeyCredentials(userId: string) {
  return useQuery({
    queryKey: adminKeys.userPublicKeyCredentials(userId),
    queryFn: async () => api.getPublicKeyCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreatePublicKeyCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: NewPublicKeyCredential) => api.createPublicKeyCredential(userId, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userPublicKeyCredentials(userId) })
    },
  })
}

export function useDeletePublicKeyCredential(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deletePublicKeyCredential(userId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userPublicKeyCredentials(userId) })
    },
  })
}

// ============================================================
// Roles (for role assignment in user detail)
// ============================================================

export function useRoles(search?: string) {
  return useQuery({
    queryKey: search != null && search !== '' ? [...adminKeys.roles, { search }] : adminKeys.roles,
    queryFn: async () => api.getRoles(search),
  })
}

export function useCreateRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: RoleDataRequest) => api.createRole(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.roles })
    },
  })
}

export function useRoleQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.role(id),
    queryFn: async () => api.getRole(id),
    enabled: !!id,
  })
}

export function useRoleUsersQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.roleUsers(id),
    queryFn: async () => api.getRoleUsers(id),
    enabled: !!id,
  })
}

export function useRoleTargetsQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.roleTargets(id),
    queryFn: async () => api.getRoleTargets(id),
    enabled: !!id,
  })
}

export function useUpdateRoleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, req }: { id: string, req: RoleDataRequest }) => api.updateRole(id, req),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.roles })
      void queryClient.invalidateQueries({ queryKey: adminKeys.role(id) })
    },
  })
}

export function useDeleteRoleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteRole(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.roles })
    },
  })
}

// ============================================================
// Tickets
// ============================================================

export function useTicketsQuery() {
  return useQuery({
    queryKey: adminKeys.tickets,
    queryFn: async () => api.getTickets(),
  })
}

export function useCreateTicketMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: CreateTicketRequest) => api.createTicket(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.tickets })
    },
  })
}

export function useDeleteTicketMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteTicket(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.tickets })
    },
  })
}

// ============================================================
// Parameters
// ============================================================

export function useParametersQuery() {
  return useQuery({
    queryKey: adminKeys.parameters,
    queryFn: async () => api.getParameters(),
  })
}

export function useUpdateParametersMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: ParameterUpdate) => api.updateParameters(req),
    onSuccess: (data) => {
      queryClient.setQueryData(adminKeys.parameters, data)
    },
  })
}

// ============================================================
// LDAP Servers
// ============================================================

export function useLdapServersQuery(search?: string) {
  return useQuery({
    queryKey: search != null && search !== '' ? [...adminKeys.ldapServers, { search }] : adminKeys.ldapServers,
    queryFn: async () => api.getLdapServers(search),
  })
}

export function useLdapServerQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.ldapServer(id),
    queryFn: async () => api.getLdapServer(id),
    enabled: !!id,
  })
}

export function useLdapUsersQuery(id: string, enabled = false) {
  return useQuery({
    queryKey: adminKeys.ldapUsers(id),
    queryFn: async () => api.getLdapUsers(id),
    enabled: enabled && !!id,
  })
}

export function useCreateLdapServerMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: CreateLdapServerRequest) => api.createLdapServer(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.ldapServers })
    },
  })
}

export function useUpdateLdapServerMutation(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: UpdateLdapServerRequest) => api.updateLdapServer(id, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.ldapServers })
      void queryClient.invalidateQueries({ queryKey: adminKeys.ldapServer(id) })
    },
  })
}

export function useDeleteLdapServerMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteLdapServer(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.ldapServers })
    },
  })
}

export function useTestLdapMutation() {
  return useMutation({
    mutationFn: async (req: TestLdapServerRequest) => api.testLdapServerConnection(req),
  })
}

export function useImportLdapUsersMutation(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: ImportLdapUsersRequest) => api.importLdapUsers(id, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.ldapUsers(id) })
    },
  })
}

// ============================================================
// Logs
// ============================================================

export function useLogsQuery(params: GetLogsRequest, options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: [...adminKeys.logs, params],
    queryFn: async () => api.getLogs(params),
    refetchInterval: options?.refetchInterval,
  })
}

// ============================================================
// Target Groups
// ============================================================

export function useTargetGroupsQuery() {
  return useQuery({
    queryKey: adminKeys.targetGroups,
    queryFn: async () => api.listTargetGroups(),
  })
}

export function useTargetGroupQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.targetGroup(id),
    queryFn: async () => api.getTargetGroup(id),
    enabled: !!id,
  })
}

export function useCreateTargetGroupMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: TargetGroupDataRequest) => api.createTargetGroup(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targetGroups })
    },
  })
}

export function useUpdateTargetGroupMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, req }: { id: string, req: TargetGroupDataRequest }) =>
      api.updateTargetGroup(id, req),
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targetGroups })
      void queryClient.invalidateQueries({ queryKey: adminKeys.targetGroup(id) })
    },
  })
}

export function useDeleteTargetGroupMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteTargetGroup(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targetGroups })
    },
  })
}

export function useTargetsByGroupQuery(groupId: string) {
  return useQuery({
    queryKey: adminKeys.targetsByGroup(groupId),
    queryFn: async () => api.getTargets({ group_id: groupId }),
    enabled: !!groupId,
  })
}

// ============================================================
// Targets
// ============================================================

export function useTargets(params?: { search?: string, group_id?: string }) {
  return useQuery({
    queryKey: [...adminKeys.targets, params?.group_id ?? null],
    queryFn: async () => api.getTargets(params),
  })
}

export function useTarget(id: string) {
  return useQuery({
    queryKey: adminKeys.target(id),
    queryFn: async () => api.getTarget(id),
    enabled: !!id,
  })
}

export function useTargetRoles(id: string) {
  return useQuery({
    queryKey: [...adminKeys.target(id), 'roles'],
    queryFn: async () => api.getTargetRoles(id),
    enabled: !!id,
  })
}

export function useTargetSshHostKeys(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...adminKeys.target(id), 'ssh-host-keys'],
    queryFn: async () => api.getSshTargetKnownSshHostKeys(id),
    enabled: enabled && !!id,
  })
}

export function useCreateTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: TargetDataRequest) => api.createTarget(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targets })
      toast.success('Target created')
    },
    onError: handleMutationError,
  })
}

export function useUpdateTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, req }: { id: string, req: TargetDataRequest }) =>
      api.updateTarget(id, req),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targets })
      void queryClient.invalidateQueries({ queryKey: adminKeys.target(id) })
      toast.success('Target updated')
    },
    onError: handleMutationError,
  })
}

export function useDeleteTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteTarget(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targets })
      toast.success('Target deleted')
    },
    onError: handleMutationError,
  })
}

export function useAddTargetRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ targetId, roleId }: { targetId: string, roleId: string }) =>
      api.addTargetRole(targetId, roleId),
    onSuccess: (_data, { targetId }) => {
      void queryClient.invalidateQueries({ queryKey: [...adminKeys.target(targetId), 'roles'] })
      toast.success('Role added')
    },
    onError: handleMutationError,
  })
}

export function useRemoveTargetRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ targetId, roleId }: { targetId: string, roleId: string }) =>
      api.deleteTargetRole(targetId, roleId),
    onSuccess: (_data, { targetId }) => {
      void queryClient.invalidateQueries({ queryKey: [...adminKeys.target(targetId), 'roles'] })
      toast.success('Role removed')
    },
    onError: handleMutationError,
  })
}

// ============================================================
// User Credentials - OTP
// ============================================================

export function useOtpCredentialsQuery(userId: string) {
  return useQuery({
    queryKey: adminKeys.userOtpCredentials(userId),
    queryFn: async () => api.getOtpCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreateOtpCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: NewOtpCredential) => api.createOtpCredential(userId, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userOtpCredentials(userId) })
    },
  })
}

export function useDeleteOtpCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteOtpCredential(userId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userOtpCredentials(userId) })
    },
  })
}

// ============================================================
// User Credentials - Certificates
// ============================================================

export function useCertCredentialsQuery(userId: string) {
  return useQuery({
    queryKey: adminKeys.userCertCredentials(userId),
    queryFn: async () => api.getCertificateCredentials(userId),
    enabled: !!userId,
  })
}

export function useIssueCertCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: IssueCertificateCredentialRequest) => api.issueCertificateCredential(userId, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userCertCredentials(userId) })
    },
  })
}

export function useUpdateCertCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, req }: { id: string, req: UpdateCertificateCredential }) =>
      api.updateCertificateCredential(userId, id, req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userCertCredentials(userId) })
    },
  })
}

export function useRevokeCertCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.revokeCertificateCredential(userId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.userCertCredentials(userId) })
    },
  })
}

// ============================================================
// User LDAP Link
// ============================================================

export function useUnlinkUserFromLdapMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.unlinkUserFromLdap(id),
    onSuccess: (data) => {
      queryClient.setQueryData(adminKeys.user(data.id), data)
    },
  })
}

export function useAutoLinkUserToLdapMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.autoLinkUserToLdap(id),
    onSuccess: (data) => {
      queryClient.setQueryData(adminKeys.user(data.id), data)
    },
  })
}

// Convenience aliases matching the naming convention used elsewhere
export const useUsersQuery = useUsers
export const useUserQuery = useUser
export const useCreateUserMutation = useCreateUser
export const useUpdateUserMutation = useUpdateUser
export const useDeleteUserMutation = useDeleteUser

// Target hook aliases
export const useTargetsQuery = useTargets
export const useTargetQuery = useTarget
export const useCreateTargetMutation = useCreateTarget
export const useUpdateTargetMutation = useUpdateTarget
export const useDeleteTargetMutation = useDeleteTarget
export const useTargetRolesMutation = useAddTargetRole
export const useTargetSshKnownHostsQuery = useTargetSshHostKeys

export { stringifyError }
