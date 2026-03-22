// ============================================================================
// Types (generated from openapi-schema.json)
// ============================================================================

export type BootstrapThemeColor =
  | 'Primary'
  | 'Secondary'
  | 'Success'
  | 'Danger'
  | 'Warning'
  | 'Info'
  | 'Light'
  | 'Dark'

export type CredentialKind = 'Password' | 'PublicKey' | 'Certificate' | 'Totp' | 'Sso' | 'WebUserApproval'
export type RecordingKind = 'Terminal' | 'Traffic' | 'Kubernetes' | 'Api'
export type TlsMode = 'Disabled' | 'Preferred' | 'Required'
export type LdapUsernameAttribute = 'Cn' | 'Uid' | 'Email' | 'UserPrincipalName' | 'SamAccountName'

export interface UserRequireCredentialsPolicy {
  http?: CredentialKind[]
  kubernetes?: CredentialKind[]
  ssh?: CredentialKind[]
  mysql?: CredentialKind[]
  postgres?: CredentialKind[]
}

export interface PaginatedResponse<T> {
  items: T[]
  offset: number
  total: number
}

export interface SessionSnapshot {
  id: string
  username?: string
  target?: Target
  started: string
  ended?: string
  ticket_id?: string
  protocol: string
}

export interface Recording {
  id: string
  name: string
  started: string
  ended?: string
  session_id: string
  kind: RecordingKind
  metadata: string
}

export interface KubernetesRecordingItem {
  timestamp: string
  request_method: string
  request_path: string
  request_body: unknown
  response_status?: number
  response_body: unknown
}

export interface Role {
  id: string
  name: string
  description: string
}

export interface RoleDataRequest {
  name: string
  description?: string
}

export interface Ticket {
  id: string
  username: string
  description: string
  target: string
  uses_left?: number
  expiry?: string
  created: string
}

export interface TicketAndSecret {
  ticket: Ticket
  secret: string
}

export interface CreateTicketRequest {
  username: string
  target_name: string
  expiry?: string
  number_of_uses?: number
  description?: string
}

export interface SSHKnownHost {
  id: string
  host: string
  port: number
  key_type: string
  key_base64: string
}

export interface AddSshKnownHostRequest {
  host: string
  port: number
  key_type: string
  key_base64: string
}

export interface SSHKey {
  kind: string
  public_key_base64: string
}

export interface CheckSshHostKeyRequest {
  host: string
  port: number
}

export interface CheckSshHostKeyResponseBody {
  remote_key_type: string
  remote_key_base64: string
}

export interface LogEntry {
  id: string
  text: string
  values: unknown
  timestamp: string
  session_id: string
  username?: string
}

export interface GetLogsRequest {
  before?: string
  after?: string
  limit?: number
  session_id?: string
  username?: string
  search?: string
}

export interface Tls {
  mode: TlsMode
  verify: boolean
}

export interface SshTargetPasswordAuth {
  password: string
}

export interface SshTargetPublicKeyAuth {}

export type SSHTargetAuth =
  | ({ kind: 'Password' } & SshTargetPasswordAuth)
  | ({ kind: 'PublicKey' } & SshTargetPublicKeyAuth)

export interface KubernetesTargetTokenAuth {
  token: string
}

export interface KubernetesTargetCertificateAuth {
  certificate: string
  private_key: string
}

export type KubernetesTargetAuth =
  | ({ kind: 'Token' } & KubernetesTargetTokenAuth)
  | ({ kind: 'Certificate' } & KubernetesTargetCertificateAuth)

export interface TargetSSHOptions {
  host: string
  port: number
  username: string
  allow_insecure_algos?: boolean
  auth: SSHTargetAuth
}

export interface TargetKubernetesOptions {
  cluster_url: string
  tls: Tls
  auth: KubernetesTargetAuth
}

export interface TargetMySqlOptions {
  host: string
  port: number
  username: string
  password?: string
  tls: Tls
  default_database_name?: string
}

export interface TargetPostgresOptions {
  host: string
  port: number
  username: string
  password?: string
  tls: Tls
  idle_timeout?: string
  default_database_name?: string
}

export interface TargetWebAdminOptions {}

export interface TargetApiOptions {
  url: string
  tls: Tls
  headers: Record<string, string>
}

export type TargetOptions =
  | ({ kind: 'Ssh' } & TargetSSHOptions)
  | ({ kind: 'Kubernetes' } & TargetKubernetesOptions)
  | ({ kind: 'MySql' } & TargetMySqlOptions)
  | ({ kind: 'Postgres' } & TargetPostgresOptions)
  | ({ kind: 'WebAdmin' } & TargetWebAdminOptions)
  | ({ kind: 'Api' } & TargetApiOptions)

export interface Target {
  id: string
  name: string
  description: string
  allow_roles: string[]
  options: TargetOptions
  rate_limit_bytes_per_second?: number
  group_id?: string
}

export interface TargetDataRequest {
  name: string
  description?: string
  options: TargetOptions
  rate_limit_bytes_per_second?: number
  group_id?: string
}

export interface TargetGroup {
  id: string
  name: string
  description: string
  color?: BootstrapThemeColor
}

export interface TargetGroupDataRequest {
  name: string
  description?: string
  color?: BootstrapThemeColor
}

export interface User {
  id: string
  username: string
  description: string
  credential_policy?: UserRequireCredentialsPolicy
  rate_limit_bytes_per_second?: number
  ldap_server_id?: string
}

export interface CreateUserRequest {
  username: string
  description?: string
}

export interface UserDataRequest {
  username: string
  credential_policy?: UserRequireCredentialsPolicy
  description?: string
  rate_limit_bytes_per_second?: number
}

export interface ExistingPasswordCredential {
  id: string
}

export interface NewPasswordCredential {
  password: string
}

export interface ExistingPublicKeyCredential {
  id: string
  label: string
  date_added?: string
  last_used?: string
  openssh_public_key: string
}

export interface NewPublicKeyCredential {
  label: string
  openssh_public_key: string
}

export interface ExistingOtpCredential {
  id: string
}

export interface NewOtpCredential {
  secret_key: number[]
}

export interface ExistingSsoCredential {
  id: string
  provider?: string
  email: string
}

export interface NewSsoCredential {
  provider?: string
  email: string
}

export interface ExistingCertificateCredential {
  id: string
  label: string
  date_added?: string
  last_used?: string
  fingerprint: string
}

export interface IssueCertificateCredentialRequest {
  label: string
  public_key_pem: string
}

export interface IssuedCertificateCredential {
  credential: ExistingCertificateCredential
  certificate_pem: string
}

export interface UpdateCertificateCredential {
  label: string
}

export interface LdapServerResponse {
  id: string
  name: string
  host: string
  port: number
  bind_dn: string
  user_filter: string
  base_dns: string[]
  tls_mode: TlsMode
  tls_verify: boolean
  enabled: boolean
  auto_link_sso_users: boolean
  description: string
  username_attribute: LdapUsernameAttribute
  ssh_key_attribute: string
  uuid_attribute: string
}

export interface CreateLdapServerRequest {
  name: string
  host: string
  port?: number
  bind_dn: string
  bind_password: string
  user_filter?: string
  tls_mode?: TlsMode
  tls_verify?: boolean
  enabled?: boolean
  auto_link_sso_users?: boolean
  description?: string
  username_attribute?: LdapUsernameAttribute
  ssh_key_attribute?: string
  uuid_attribute?: string
}

export interface UpdateLdapServerRequest {
  name: string
  host: string
  port: number
  bind_dn: string
  bind_password?: string
  user_filter: string
  tls_mode: TlsMode
  tls_verify: boolean
  enabled: boolean
  auto_link_sso_users: boolean
  description?: string
  username_attribute: LdapUsernameAttribute
  ssh_key_attribute: string
  uuid_attribute: string
}

export interface TestLdapServerRequest {
  host: string
  port: number
  bind_dn: string
  bind_password: string
  tls_mode: TlsMode
  tls_verify: boolean
}

export interface TestLdapServerResponse {
  success: boolean
  message: string
  base_dns?: string[]
}

export interface LdapUserResponse {
  username: string
  email?: string
  display_name?: string
  dn: string
}

export interface ImportLdapUsersRequest {
  dns: string[]
}

export interface ParameterValues {
  allow_own_credential_management: boolean
  rate_limit_bytes_per_second?: number
  ssh_client_auth_publickey: boolean
  ssh_client_auth_password: boolean
  ssh_client_auth_keyboard_interactive: boolean
  minimize_password_login: boolean
}

export interface ParameterUpdate {
  allow_own_credential_management: boolean
  rate_limit_bytes_per_second?: number
  ssh_client_auth_publickey?: boolean
  ssh_client_auth_password?: boolean
  ssh_client_auth_keyboard_interactive?: boolean
  minimize_password_login?: boolean
}

// ============================================================================
// Configuration
// ============================================================================

export class Configuration {
  basePath: string
  headers?: Record<string, string>

  constructor(params: { basePath?: string; headers?: Record<string, string> } = {}) {
    this.basePath = params.basePath ?? ''
    this.headers = params.headers
  }
}

// ============================================================================
// ResponseError
// ============================================================================

export class ResponseError extends Error {
  response: Response
  constructor(response: Response, message?: string) {
    super(message ?? `Response returned an error code: ${response.status}`)
    this.response = response
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

async function fetchApi(
  config: Configuration,
  path: string,
  method: string,
  body?: unknown,
  queryParams?: Record<string, string | number | boolean | undefined>,
): Promise<Response> {
  let url = `${config.basePath}${path}`
  if (queryParams) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value))
      }
    }
    const qs = params.toString()
    if (qs) url += `?${qs}`
  }
  const headers: Record<string, string> = { ...config.headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })
  if (!res.ok) throw new ResponseError(res)
  return res
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

// ============================================================================
// DefaultApi
// ============================================================================

export class DefaultApi {
  private config: Configuration

  constructor(config: Configuration) {
    this.config = config
  }

  // Sessions
  async getSessions(params?: { offset?: number; limit?: number; active_only?: boolean; logged_in_only?: boolean }): Promise<PaginatedResponse<SessionSnapshot>> {
    const res = await fetchApi(this.config, '/sessions', 'GET', undefined, params as Record<string, string | number | boolean | undefined>)
    return json<PaginatedResponse<SessionSnapshot>>(res)
  }

  async closeAllSessions(): Promise<void> {
    await fetchApi(this.config, '/sessions', 'DELETE')
  }

  async getSession(id: string): Promise<SessionSnapshot> {
    const res = await fetchApi(this.config, `/sessions/${id}`, 'GET')
    return json<SessionSnapshot>(res)
  }

  async getSessionRecordings(id: string): Promise<Recording[]> {
    const res = await fetchApi(this.config, `/sessions/${id}/recordings`, 'GET')
    return json<Recording[]>(res)
  }

  async closeSession(id: string): Promise<void> {
    await fetchApi(this.config, `/sessions/${id}/close`, 'POST')
  }

  // Recordings
  async getRecording(id: string): Promise<Recording> {
    const res = await fetchApi(this.config, `/recordings/${id}`, 'GET')
    return json<Recording>(res)
  }

  async getKubernetesRecording(id: string): Promise<KubernetesRecordingItem[]> {
    const res = await fetchApi(this.config, `/recordings/${id}/kubernetes`, 'GET')
    return json<KubernetesRecordingItem[]>(res)
  }

  // Roles
  async getRoles(search?: string): Promise<Role[]> {
    const res = await fetchApi(this.config, '/roles', 'GET', undefined, search ? { search } : undefined)
    return json<Role[]>(res)
  }

  async createRole(req: RoleDataRequest): Promise<Role> {
    const res = await fetchApi(this.config, '/roles', 'POST', req)
    return json<Role>(res)
  }

  async getRole(id: string): Promise<Role> {
    const res = await fetchApi(this.config, `/role/${id}`, 'GET')
    return json<Role>(res)
  }

  async updateRole(id: string, req: RoleDataRequest): Promise<Role> {
    const res = await fetchApi(this.config, `/role/${id}`, 'PUT', req)
    return json<Role>(res)
  }

  async deleteRole(id: string): Promise<void> {
    await fetchApi(this.config, `/role/${id}`, 'DELETE')
  }

  async getRoleTargets(id: string): Promise<Target[]> {
    const res = await fetchApi(this.config, `/role/${id}/targets`, 'GET')
    return json<Target[]>(res)
  }

  async getRoleUsers(id: string): Promise<User[]> {
    const res = await fetchApi(this.config, `/role/${id}/users`, 'GET')
    return json<User[]>(res)
  }

  // Tickets
  async getTickets(): Promise<Ticket[]> {
    const res = await fetchApi(this.config, '/tickets', 'GET')
    return json<Ticket[]>(res)
  }

  async createTicket(req: CreateTicketRequest): Promise<TicketAndSecret> {
    const res = await fetchApi(this.config, '/tickets', 'POST', req)
    return json<TicketAndSecret>(res)
  }

  async deleteTicket(id: string): Promise<void> {
    await fetchApi(this.config, `/tickets/${id}`, 'DELETE')
  }

  // SSH Known Hosts
  async addSshKnownHost(req: AddSshKnownHostRequest): Promise<SSHKnownHost> {
    const res = await fetchApi(this.config, '/ssh/known-hosts', 'POST', req)
    return json<SSHKnownHost>(res)
  }

  async getSshKnownHosts(): Promise<SSHKnownHost[]> {
    const res = await fetchApi(this.config, '/ssh/known-hosts', 'GET')
    return json<SSHKnownHost[]>(res)
  }

  async deleteSshKnownHost(id: string): Promise<void> {
    await fetchApi(this.config, `/ssh/known-hosts/${id}`, 'DELETE')
  }

  async getSshOwnKeys(): Promise<SSHKey[]> {
    const res = await fetchApi(this.config, '/ssh/own-keys', 'GET')
    return json<SSHKey[]>(res)
  }

  async checkSshHostKey(req: CheckSshHostKeyRequest): Promise<CheckSshHostKeyResponseBody> {
    const res = await fetchApi(this.config, '/ssh/check-host-key', 'POST', req)
    return json<CheckSshHostKeyResponseBody>(res)
  }

  // Logs
  async getLogs(req: GetLogsRequest): Promise<LogEntry[]> {
    const res = await fetchApi(this.config, '/logs', 'POST', req)
    return json<LogEntry[]>(res)
  }

  // Targets
  async getTargets(params?: { search?: string; group_id?: string }): Promise<Target[]> {
    const res = await fetchApi(this.config, '/targets', 'GET', undefined, params as Record<string, string | number | boolean | undefined>)
    return json<Target[]>(res)
  }

  async createTarget(req: TargetDataRequest): Promise<Target> {
    const res = await fetchApi(this.config, '/targets', 'POST', req)
    return json<Target>(res)
  }

  async getTarget(id: string): Promise<Target> {
    const res = await fetchApi(this.config, `/targets/${id}`, 'GET')
    return json<Target>(res)
  }

  async updateTarget(id: string, req: TargetDataRequest): Promise<Target> {
    const res = await fetchApi(this.config, `/targets/${id}`, 'PUT', req)
    return json<Target>(res)
  }

  async deleteTarget(id: string): Promise<void> {
    await fetchApi(this.config, `/targets/${id}`, 'DELETE')
  }

  async getSshTargetKnownSshHostKeys(id: string): Promise<SSHKnownHost[]> {
    const res = await fetchApi(this.config, `/targets/${id}/known-ssh-host-keys`, 'GET')
    return json<SSHKnownHost[]>(res)
  }

  async getTargetRoles(id: string): Promise<Role[]> {
    const res = await fetchApi(this.config, `/targets/${id}/roles`, 'GET')
    return json<Role[]>(res)
  }

  async addTargetRole(id: string, roleId: string): Promise<void> {
    await fetchApi(this.config, `/targets/${id}/roles/${roleId}`, 'POST')
  }

  async deleteTargetRole(id: string, roleId: string): Promise<void> {
    await fetchApi(this.config, `/targets/${id}/roles/${roleId}`, 'DELETE')
  }

  // Target Groups
  async listTargetGroups(): Promise<TargetGroup[]> {
    const res = await fetchApi(this.config, '/target-groups', 'GET')
    return json<TargetGroup[]>(res)
  }

  async createTargetGroup(req: TargetGroupDataRequest): Promise<TargetGroup> {
    const res = await fetchApi(this.config, '/target-groups', 'POST', req)
    return json<TargetGroup>(res)
  }

  async getTargetGroup(id: string): Promise<TargetGroup> {
    const res = await fetchApi(this.config, `/target-groups/${id}`, 'GET')
    return json<TargetGroup>(res)
  }

  async updateTargetGroup(id: string, req: TargetGroupDataRequest): Promise<TargetGroup> {
    const res = await fetchApi(this.config, `/target-groups/${id}`, 'PUT', req)
    return json<TargetGroup>(res)
  }

  async deleteTargetGroup(id: string): Promise<void> {
    await fetchApi(this.config, `/target-groups/${id}`, 'DELETE')
  }

  // Users
  async getUsers(search?: string): Promise<User[]> {
    const res = await fetchApi(this.config, '/users', 'GET', undefined, search ? { search } : undefined)
    return json<User[]>(res)
  }

  async createUser(req: CreateUserRequest): Promise<User> {
    const res = await fetchApi(this.config, '/users', 'POST', req)
    return json<User>(res)
  }

  async getUser(id: string): Promise<User> {
    const res = await fetchApi(this.config, `/users/${id}`, 'GET')
    return json<User>(res)
  }

  async updateUser(id: string, req: UserDataRequest): Promise<User> {
    const res = await fetchApi(this.config, `/users/${id}`, 'PUT', req)
    return json<User>(res)
  }

  async deleteUser(id: string): Promise<void> {
    await fetchApi(this.config, `/users/${id}`, 'DELETE')
  }

  async unlinkUserFromLdap(id: string): Promise<User> {
    const res = await fetchApi(this.config, `/users/${id}/ldap-link/unlink`, 'POST')
    return json<User>(res)
  }

  async autoLinkUserToLdap(id: string): Promise<User> {
    const res = await fetchApi(this.config, `/users/${id}/ldap-link/auto-link`, 'POST')
    return json<User>(res)
  }

  async getUserRoles(id: string): Promise<Role[]> {
    const res = await fetchApi(this.config, `/users/${id}/roles`, 'GET')
    return json<Role[]>(res)
  }

  async addUserRole(id: string, roleId: string): Promise<void> {
    await fetchApi(this.config, `/users/${id}/roles/${roleId}`, 'POST')
  }

  async deleteUserRole(id: string, roleId: string): Promise<void> {
    await fetchApi(this.config, `/users/${id}/roles/${roleId}`, 'DELETE')
  }

  // User Credentials - Passwords
  async getPasswordCredentials(userId: string): Promise<ExistingPasswordCredential[]> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/passwords`, 'GET')
    return json<ExistingPasswordCredential[]>(res)
  }

  async createPasswordCredential(userId: string, req: NewPasswordCredential): Promise<ExistingPasswordCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/passwords`, 'POST', req)
    return json<ExistingPasswordCredential>(res)
  }

  async deletePasswordCredential(userId: string, id: string): Promise<void> {
    await fetchApi(this.config, `/users/${userId}/credentials/passwords/${id}`, 'DELETE')
  }

  // User Credentials - SSO
  async getSsoCredentials(userId: string): Promise<ExistingSsoCredential[]> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/sso`, 'GET')
    return json<ExistingSsoCredential[]>(res)
  }

  async createSsoCredential(userId: string, req: NewSsoCredential): Promise<ExistingSsoCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/sso`, 'POST', req)
    return json<ExistingSsoCredential>(res)
  }

  async updateSsoCredential(userId: string, id: string, req: NewSsoCredential): Promise<ExistingSsoCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/sso/${id}`, 'PUT', req)
    return json<ExistingSsoCredential>(res)
  }

  async deleteSsoCredential(userId: string, id: string): Promise<void> {
    await fetchApi(this.config, `/users/${userId}/credentials/sso/${id}`, 'DELETE')
  }

  // User Credentials - Public Keys
  async getPublicKeyCredentials(userId: string): Promise<ExistingPublicKeyCredential[]> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/public-keys`, 'GET')
    return json<ExistingPublicKeyCredential[]>(res)
  }

  async createPublicKeyCredential(userId: string, req: NewPublicKeyCredential): Promise<ExistingPublicKeyCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/public-keys`, 'POST', req)
    return json<ExistingPublicKeyCredential>(res)
  }

  async updatePublicKeyCredential(userId: string, id: string, req: NewPublicKeyCredential): Promise<ExistingPublicKeyCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/public-keys/${id}`, 'PUT', req)
    return json<ExistingPublicKeyCredential>(res)
  }

  async deletePublicKeyCredential(userId: string, id: string): Promise<void> {
    await fetchApi(this.config, `/users/${userId}/credentials/public-keys/${id}`, 'DELETE')
  }

  // User Credentials - OTP
  async getOtpCredentials(userId: string): Promise<ExistingOtpCredential[]> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/otp`, 'GET')
    return json<ExistingOtpCredential[]>(res)
  }

  async createOtpCredential(userId: string, req: NewOtpCredential): Promise<ExistingOtpCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/otp`, 'POST', req)
    return json<ExistingOtpCredential>(res)
  }

  async deleteOtpCredential(userId: string, id: string): Promise<void> {
    await fetchApi(this.config, `/users/${userId}/credentials/otp/${id}`, 'DELETE')
  }

  // User Credentials - Certificates
  async getCertificateCredentials(userId: string): Promise<ExistingCertificateCredential[]> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/certificates`, 'GET')
    return json<ExistingCertificateCredential[]>(res)
  }

  async issueCertificateCredential(userId: string, req: IssueCertificateCredentialRequest): Promise<IssuedCertificateCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/certificates`, 'POST', req)
    return json<IssuedCertificateCredential>(res)
  }

  async updateCertificateCredential(userId: string, id: string, req: UpdateCertificateCredential): Promise<ExistingCertificateCredential> {
    const res = await fetchApi(this.config, `/users/${userId}/credentials/certificates/${id}`, 'PATCH', req)
    return json<ExistingCertificateCredential>(res)
  }

  async revokeCertificateCredential(userId: string, id: string): Promise<void> {
    await fetchApi(this.config, `/users/${userId}/credentials/certificates/${id}`, 'DELETE')
  }

  // LDAP Servers
  async getLdapServers(search?: string): Promise<LdapServerResponse[]> {
    const res = await fetchApi(this.config, '/ldap-servers', 'GET', undefined, search ? { search } : undefined)
    return json<LdapServerResponse[]>(res)
  }

  async createLdapServer(req: CreateLdapServerRequest): Promise<LdapServerResponse> {
    const res = await fetchApi(this.config, '/ldap-servers', 'POST', req)
    return json<LdapServerResponse>(res)
  }

  async testLdapServerConnection(req: TestLdapServerRequest): Promise<TestLdapServerResponse> {
    const res = await fetchApi(this.config, '/ldap-servers/test', 'POST', req)
    return json<TestLdapServerResponse>(res)
  }

  async getLdapServer(id: string): Promise<LdapServerResponse> {
    const res = await fetchApi(this.config, `/ldap-servers/${id}`, 'GET')
    return json<LdapServerResponse>(res)
  }

  async updateLdapServer(id: string, req: UpdateLdapServerRequest): Promise<LdapServerResponse> {
    const res = await fetchApi(this.config, `/ldap-servers/${id}`, 'PUT', req)
    return json<LdapServerResponse>(res)
  }

  async deleteLdapServer(id: string): Promise<void> {
    await fetchApi(this.config, `/ldap-servers/${id}`, 'DELETE')
  }

  async getLdapUsers(id: string): Promise<LdapUserResponse[]> {
    const res = await fetchApi(this.config, `/ldap-servers/${id}/users`, 'GET')
    return json<LdapUserResponse[]>(res)
  }

  async importLdapUsers(id: string, req: ImportLdapUsersRequest): Promise<string[]> {
    const res = await fetchApi(this.config, `/ldap-servers/${id}/import-users`, 'POST', req)
    return json<string[]>(res)
  }

  // Parameters
  async getParameters(): Promise<ParameterValues> {
    const res = await fetchApi(this.config, '/parameters', 'GET')
    return json<ParameterValues>(res)
  }

  async updateParameters(req: ParameterUpdate): Promise<ParameterValues> {
    const res = await fetchApi(this.config, '/parameters', 'PUT', req)
    return json<ParameterValues>(res)
  }

  // Recording cast (asciicast v2 text)
  async getRecordingCast(id: string): Promise<string> {
    const res = await fetchApi(this.config, `/recordings/${id}/cast`, 'GET')
    return res.text()
  }
}
