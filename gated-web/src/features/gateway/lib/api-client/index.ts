// ============================================================================
// Types (generated from openapi-schema.json)
// ============================================================================

export type ApiAuthState =
  | 'NotStarted'
  | 'Failed'
  | 'PasswordNeeded'
  | 'OtpNeeded'
  | 'SsoNeeded'
  | 'WebUserApprovalNeeded'
  | 'PublicKeyNeeded'
  | 'Success'

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
export type PasswordState = 'Unset' | 'Set' | 'MultipleSet'
export type SsoProviderKind = 'Google' | 'Apple' | 'Azure' | 'Custom'
export type TargetKind = 'Kubernetes' | 'MySql' | 'Ssh' | 'Postgres' | 'WebAdmin' | 'Api'

export interface AuthStateResponseInternal {
  id: string
  protocol: string
  address?: string
  started: string
  state: ApiAuthState
  identification_string: string
}

export interface LoginRequest {
  username: string
  password: string
}

export interface OtpLoginRequest {
  otp: string
}

export interface LoginFailureResponse {
  state: ApiAuthState
}

export interface ChangePasswordRequest {
  password: string
}

export interface PortsInfo {
  ssh?: number
  http?: number
  mysql?: number
  postgres?: number
  kubernetes?: number
}

export interface SetupState {
  has_targets: boolean
  has_users: boolean
}

export interface Info {
  version?: string
  username?: string
  admin?: boolean
  selected_target?: string
  external_host?: string
  ports: PortsInfo
  minimize_password_login: boolean
  authorized_via_ticket: boolean
  authorized_via_sso_with_single_logout: boolean
  own_credential_management_allowed: boolean
  has_ldap: boolean
  setup_state?: SetupState
}

export interface GroupInfo {
  id: string
  name: string
  color?: BootstrapThemeColor
}

export interface TargetSnapshot {
  name: string
  description: string
  kind: TargetKind
  group?: GroupInfo
  default_database_name?: string
}

export interface SsoProviderDescription {
  name: string
  label: string
  kind: SsoProviderKind
}

export interface StartSsoResponseParams {
  url: string
}

export interface StartSloResponseParams {
  url: string
}

export interface UserRequireCredentialsPolicy {
  http?: CredentialKind[]
  kubernetes?: CredentialKind[]
  ssh?: CredentialKind[]
  mysql?: CredentialKind[]
  postgres?: CredentialKind[]
}

export interface ExistingOtpCredential {
  id: string
}

export interface ExistingPublicKeyCredential {
  id: string
  label: string
  date_added?: string
  last_used?: string
  abbreviated: string
}

export interface ExistingCertificateCredential {
  id: string
  label: string
  date_added?: string
  last_used?: string
  fingerprint: string
}

export interface ExistingSsoCredential {
  id: string
  provider?: string
  email: string
}

export interface CredentialsState {
  password: PasswordState
  otp: ExistingOtpCredential[]
  public_keys: ExistingPublicKeyCredential[]
  certificates: ExistingCertificateCredential[]
  sso: ExistingSsoCredential[]
  credential_policy: UserRequireCredentialsPolicy
  ldap_linked: boolean
}

export interface NewPublicKeyCredential {
  label: string
  openssh_public_key: string
}

export interface NewOtpCredential {
  secret_key: number[]
}

export interface IssueCertificateCredentialRequest {
  label: string
  public_key_pem: string
}

export interface IssuedCertificateCredential {
  credential: ExistingCertificateCredential
  certificate_pem: string
}

export interface ExistingApiToken {
  id: string
  label: string
  created: string
  expiry: string
}

export interface NewApiToken {
  label: string
  expiry: string
}

export interface TokenAndSecret {
  token: ExistingApiToken
  secret: string
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
// DefaultApi
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

export class DefaultApi {
  private config: Configuration

  constructor(config: Configuration) {
    this.config = config
  }

  // Auth
  async login(req: LoginRequest): Promise<void> {
    await fetchApi(this.config, '/auth/login', 'POST', req)
  }

  async otpLogin(req: OtpLoginRequest): Promise<void> {
    await fetchApi(this.config, '/auth/otp', 'POST', req)
  }

  async logout(): Promise<void> {
    await fetchApi(this.config, '/auth/logout', 'POST')
  }

  async getDefaultAuthState(): Promise<AuthStateResponseInternal | null> {
    const res = await fetch(`${this.config.basePath}/auth/state`, { credentials: 'include' })
    if (res.status === 404) return null
    if (!res.ok) throw new ResponseError(res)
    return json<AuthStateResponseInternal>(res)
  }

  async cancelDefaultAuth(): Promise<AuthStateResponseInternal | null> {
    const res = await fetch(`${this.config.basePath}/auth/state`, { method: 'DELETE', credentials: 'include' })
    if (res.status === 404) return null
    if (!res.ok) throw new ResponseError(res)
    return json<AuthStateResponseInternal>(res)
  }

  async getWebAuthRequests(): Promise<AuthStateResponseInternal[]> {
    const res = await fetchApi(this.config, '/auth/web-auth-requests', 'GET')
    return json<AuthStateResponseInternal[]>(res)
  }

  async getAuthState(id: string): Promise<AuthStateResponseInternal | null> {
    const res = await fetch(`${this.config.basePath}/auth/state/${id}`, { credentials: 'include' })
    if (res.status === 404) return null
    if (!res.ok) throw new ResponseError(res)
    return json<AuthStateResponseInternal>(res)
  }

  async approveAuth(id: string): Promise<AuthStateResponseInternal | null> {
    const res = await fetch(`${this.config.basePath}/auth/state/${id}/approve`, { method: 'POST', credentials: 'include' })
    if (res.status === 404) return null
    if (!res.ok) throw new ResponseError(res)
    return json<AuthStateResponseInternal>(res)
  }

  async rejectAuth(id: string): Promise<AuthStateResponseInternal | null> {
    const res = await fetch(`${this.config.basePath}/auth/state/${id}/reject`, { method: 'POST', credentials: 'include' })
    if (res.status === 404) return null
    if (!res.ok) throw new ResponseError(res)
    return json<AuthStateResponseInternal>(res)
  }

  // Info
  async getInfo(): Promise<Info> {
    const res = await fetchApi(this.config, '/info', 'GET')
    return json<Info>(res)
  }

  // Targets
  async getTargets(search?: string): Promise<TargetSnapshot[]> {
    const res = await fetchApi(this.config, '/targets', 'GET', undefined, search ? { search } : undefined)
    return json<TargetSnapshot[]>(res)
  }

  // SSO
  async getSsoProviders(): Promise<SsoProviderDescription[]> {
    const res = await fetchApi(this.config, '/sso/providers', 'GET')
    return json<SsoProviderDescription[]>(res)
  }

  async initiateSsoLogout(): Promise<StartSloResponseParams> {
    const res = await fetchApi(this.config, '/sso/logout', 'GET')
    return json<StartSloResponseParams>(res)
  }

  async startSso(name: string, next?: string): Promise<StartSsoResponseParams> {
    const res = await fetchApi(this.config, `/sso/providers/${name}/start`, 'GET', undefined, next ? { next } : undefined)
    return json<StartSsoResponseParams>(res)
  }

  // Profile - Credentials
  async getMyCredentials(): Promise<CredentialsState> {
    const res = await fetchApi(this.config, '/profile/credentials', 'GET')
    return json<CredentialsState>(res)
  }

  async changeMyPassword(req: ChangePasswordRequest): Promise<PasswordState> {
    const res = await fetchApi(this.config, '/profile/credentials/password', 'POST', req)
    return json<PasswordState>(res)
  }

  async addMyPublicKey(req: NewPublicKeyCredential): Promise<ExistingPublicKeyCredential> {
    const res = await fetchApi(this.config, '/profile/credentials/public-keys', 'POST', req)
    return json<ExistingPublicKeyCredential>(res)
  }

  async deleteMyPublicKey(id: string): Promise<void> {
    await fetchApi(this.config, `/profile/credentials/public-keys/${id}`, 'DELETE')
  }

  async addMyOtp(req: NewOtpCredential): Promise<ExistingOtpCredential> {
    const res = await fetchApi(this.config, '/profile/credentials/otp', 'POST', req)
    return json<ExistingOtpCredential>(res)
  }

  async deleteMyOtp(id: string): Promise<void> {
    await fetchApi(this.config, `/profile/credentials/otp/${id}`, 'DELETE')
  }

  async issueMyCertificate(req: IssueCertificateCredentialRequest): Promise<IssuedCertificateCredential> {
    const res = await fetchApi(this.config, '/profile/credentials/certificates', 'POST', req)
    return json<IssuedCertificateCredential>(res)
  }

  async revokeMyCertificate(id: string): Promise<void> {
    await fetchApi(this.config, `/profile/credentials/certificates/${id}`, 'DELETE')
  }

  // Profile - API Tokens
  async getMyApiTokens(): Promise<ExistingApiToken[]> {
    const res = await fetchApi(this.config, '/profile/api-tokens', 'GET')
    return json<ExistingApiToken[]>(res)
  }

  async createApiToken(req: NewApiToken): Promise<TokenAndSecret> {
    const res = await fetchApi(this.config, '/profile/api-tokens', 'POST', req)
    return json<TokenAndSecret>(res)
  }

  async deleteMyApiToken(id: string): Promise<void> {
    await fetchApi(this.config, `/profile/api-tokens/${id}`, 'DELETE')
  }
}
