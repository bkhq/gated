// TanStack Query hooks for the admin API

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, stringifyError, ResponseError, type CreateUserRequest, type UserDataRequest, type NewPasswordCredential, type NewSsoCredential, type NewPublicKeyCredential, type NewOtpCredential, type IssueCertificateCredentialRequest, type UpdateCertificateCredential, type RoleDataRequest, type ParameterUpdate, type CreateLdapServerRequest, type UpdateLdapServerRequest, type TestLdapServerRequest, type ImportLdapUsersRequest, type CreateTicketRequest, type GetLogsRequest, type TargetGroupDataRequest, type TargetDataRequest } from '@/features/admin/lib/api'

import { toast } from 'sonner'

function handleMutationError(err: unknown): void {
  if (err instanceof ResponseError) {
    void err.response.text().then(text => toast.error(`API error: ${text}`))
  } else if (err instanceof Error) {
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
    queryFn: () => api.getSessions({ active_only: activeOnly }),
  })
}

export function useSessionQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.session(id),
    queryFn: () => api.getSession(id),
    enabled: !!id,
  })
}

export function useSessionRecordingsQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.sessionRecordings(id),
    queryFn: () => api.getSessionRecordings(id),
    enabled: !!id,
  })
}

export function useCloseSessionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.closeSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sessions'] })
    },
  })
}

export function useCleanSessionsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.closeAllSessions(),
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
    queryFn: () => api.getRecording(id),
    enabled: !!id,
  })
}

export function useRecordingCastQuery(id: string, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.recordingCast(id),
    queryFn: () => api.getRecordingCast(id),
    enabled: !!id && enabled,
  })
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

export function useRoleQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.role(id),
    queryFn: () => api.getRole(id),
    enabled: !!id,
  })
}

export function useRoleUsersQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.roleUsers(id),
    queryFn: () => api.getRoleUsers(id),
    enabled: !!id,
  })
}

export function useRoleTargetsQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.roleTargets(id),
    queryFn: () => api.getRoleTargets(id),
    enabled: !!id,
  })
}

export function useUpdateRoleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: RoleDataRequest }) => api.updateRole(id, req),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.roles })
      void queryClient.invalidateQueries({ queryKey: adminKeys.role(id) })
    },
  })
}

export function useDeleteRoleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteRole(id),
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
    queryFn: () => api.getTickets(),
  })
}

export function useCreateTicketMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: CreateTicketRequest) => api.createTicket(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.tickets })
    },
  })
}

export function useDeleteTicketMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteTicket(id),
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

// ============================================================
// LDAP Servers
// ============================================================

export function useLdapServersQuery(search?: string) {
  return useQuery({
    queryKey: search ? [...adminKeys.ldapServers, { search }] : adminKeys.ldapServers,
    queryFn: () => api.getLdapServers(search),
  })
}

export function useLdapServerQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.ldapServer(id),
    queryFn: () => api.getLdapServer(id),
    enabled: !!id,
  })
}

export function useLdapUsersQuery(id: string, enabled = false) {
  return useQuery({
    queryKey: adminKeys.ldapUsers(id),
    queryFn: () => api.getLdapUsers(id),
    enabled: enabled && !!id,
  })
}

export function useCreateLdapServerMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: CreateLdapServerRequest) => api.createLdapServer(req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.ldapServers })
    },
  })
}

export function useUpdateLdapServerMutation(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: UpdateLdapServerRequest) => api.updateLdapServer(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.ldapServers })
      queryClient.invalidateQueries({ queryKey: adminKeys.ldapServer(id) })
    },
  })
}

export function useDeleteLdapServerMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteLdapServer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.ldapServers })
    },
  })
}

export function useTestLdapMutation() {
  return useMutation({
    mutationFn: (req: TestLdapServerRequest) => api.testLdapServerConnection(req),
  })
}

export function useImportLdapUsersMutation(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: ImportLdapUsersRequest) => api.importLdapUsers(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.ldapUsers(id) })
    },
  })
}

// ============================================================
// Logs
// ============================================================

export function useLogsQuery(params: GetLogsRequest, options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: [...adminKeys.logs, params],
    queryFn: () => api.getLogs(params),
    refetchInterval: options?.refetchInterval,
  })
}

// ============================================================
// Target Groups
// ============================================================

export function useTargetGroupsQuery() {
  return useQuery({
    queryKey: adminKeys.targetGroups,
    queryFn: () => api.listTargetGroups(),
  })
}

export function useTargetGroupQuery(id: string) {
  return useQuery({
    queryKey: adminKeys.targetGroup(id),
    queryFn: () => api.getTargetGroup(id),
    enabled: !!id,
  })
}

export function useCreateTargetGroupMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: TargetGroupDataRequest) => api.createTargetGroup(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targetGroups })
    },
  })
}

export function useUpdateTargetGroupMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: TargetGroupDataRequest }) =>
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
    mutationFn: (id: string) => api.deleteTargetGroup(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.targetGroups })
    },
  })
}

export function useTargetsByGroupQuery(groupId: string) {
  return useQuery({
    queryKey: adminKeys.targetsByGroup(groupId),
    queryFn: () => api.getTargets({ group_id: groupId }),
    enabled: !!groupId,
  })
}

// ============================================================
// Targets
// ============================================================

export function useTargets(params?: { search?: string; group_id?: string }) {
  return useQuery({
    queryKey: [...adminKeys.targets, params?.group_id ?? null],
    queryFn: () => api.getTargets(params),
  })
}

export function useTarget(id: string) {
  return useQuery({
    queryKey: adminKeys.target(id),
    queryFn: () => api.getTarget(id),
    enabled: !!id,
  })
}

export function useTargetRoles(id: string) {
  return useQuery({
    queryKey: [...adminKeys.target(id), 'roles'],
    queryFn: () => api.getTargetRoles(id),
    enabled: !!id,
  })
}

export function useTargetSshHostKeys(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...adminKeys.target(id), 'ssh-host-keys'],
    queryFn: () => api.getSshTargetKnownSshHostKeys(id),
    enabled: enabled && !!id,
  })
}

export function useCreateTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: TargetDataRequest) => api.createTarget(req),
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
    mutationFn: ({ id, req }: { id: string; req: TargetDataRequest }) =>
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
    mutationFn: (id: string) => api.deleteTarget(id),
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
    mutationFn: ({ targetId, roleId }: { targetId: string; roleId: string }) =>
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
    mutationFn: ({ targetId, roleId }: { targetId: string; roleId: string }) =>
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
    queryFn: () => api.getOtpCredentials(userId),
    enabled: !!userId,
  })
}

export function useCreateOtpCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: NewOtpCredential) => api.createOtpCredential(userId, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userOtpCredentials(userId) })
    },
  })
}

export function useDeleteOtpCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteOtpCredential(userId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userOtpCredentials(userId) })
    },
  })
}

// ============================================================
// User Credentials - Certificates
// ============================================================

export function useCertCredentialsQuery(userId: string) {
  return useQuery({
    queryKey: adminKeys.userCertCredentials(userId),
    queryFn: () => api.getCertificateCredentials(userId),
    enabled: !!userId,
  })
}

export function useIssueCertCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: IssueCertificateCredentialRequest) => api.issueCertificateCredential(userId, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userCertCredentials(userId) })
    },
  })
}

export function useUpdateCertCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateCertificateCredential }) =>
      api.updateCertificateCredential(userId, id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userCertCredentials(userId) })
    },
  })
}

export function useRevokeCertCredentialMutation(userId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.revokeCertificateCredential(userId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.userCertCredentials(userId) })
    },
  })
}

// ============================================================
// User LDAP Link
// ============================================================

export function useUnlinkUserFromLdapMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.unlinkUserFromLdap(id),
    onSuccess: (data) => {
      queryClient.setQueryData(adminKeys.user(data.id), data)
    },
  })
}

export function useAutoLinkUserToLdapMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.autoLinkUserToLdap(id),
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

export { stringifyError }
