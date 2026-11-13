export class ApiError extends Error {
  status: number
  body: unknown
  // The request answered 401 and the global re-login handler took over.
  sessionExpired = false

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

// 401 from /api/auth/* and /api/sso/* is the normal "wrong credentials" /
// "session not yet established" response during the login flow itself.
// /api/admin/encryption/* is the boot gate's pre-auth surface: a 401 on
// unlock means "wrong master password", not "session expired" — bouncing
// the user to /auth/login would be wrong and would also blow away the
// in-progress unlock form. Firing the global redirect there would loop
// the user. Anywhere else, 401 means "session is gone, go re-login".
const SKIP_GLOBAL_UNAUTHORIZED_PREFIXES = ['/api/auth/', '/api/sso/', '/api/admin/encryption/']

// Account writes, reveals and adding a public key carry a step-up
// confirmation; their 401 means "wrong password/OTP" and is shown in the
// confirmation prompt.
function isStepUpRequest(path: string, method: string): boolean {
  if (method === 'GET')
    return false
  return path.startsWith('/admin/api/accounts') || path === '/api/profile/credentials/public-keys'
}

let onUnauthorized: (() => void) | null = null

export function setOnUnauthorized(cb: (() => void) | null): void {
  onUnauthorized = cb
}

// The gateway requires an OTP device this user has not enrolled yet.
let onMfaSetupRequired: (() => void) | null = null

export function setOnMfaSetupRequired(cb: (() => void) | null): void {
  onMfaSetupRequired = cb
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = opts
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined)
    headers['Content-Type'] = 'application/json'

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })

  const sessionExpired = response.status === 401 && path !== '/api/profile/credentials/password' && !isStepUpRequest(path, method) && !SKIP_GLOBAL_UNAUTHORIZED_PREFIXES.some(p => path.startsWith(p))
  if (sessionExpired)
    onUnauthorized?.()
  if (response.headers.get('x-gated-mfa-setup-required'))
    onMfaSetupRequired?.()

  if (response.status === 204)
    return undefined as T

  const text = await response.text()
  const parsed: unknown = text.length > 0 ? safeJsonParse(text) : undefined

  if (!response.ok) {
    const message = extractMessage(parsed) ?? `HTTP ${response.status}`
    const error = new ApiError(response.status, message, parsed)
    error.sessionExpired = sessionExpired
    throw error
  }

  return parsed as T
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

// The API answers errors with a JSON string, plain text, or an object with
// `message` or `error`.
export function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'string')
    return body.trim() || undefined
  if (body && typeof body === 'object') {
    for (const key of ['message', 'error'] as const) {
      const value = (body as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim())
        return value.trim()
    }
  }
  return undefined
}

export const userApi = {
  get: async <T>(path: string, signal?: AbortSignal) => request<T>(`/api${path}`, { signal }),
  post: async <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(`/api${path}`, { method: 'POST', body, signal }),
  put: async <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(`/api${path}`, { method: 'PUT', body, signal }),
  delete: async <T>(path: string, signal?: AbortSignal) =>
    request<T>(`/api${path}`, { method: 'DELETE', signal }),
}

export const adminApi = {
  get: async <T>(path: string, signal?: AbortSignal) => request<T>(`/admin/api${path}`, { signal }),
  post: async <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(`/admin/api${path}`, { method: 'POST', body, signal }),
  put: async <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(`/admin/api${path}`, { method: 'PUT', body, signal }),
  delete: async <T>(path: string, signal?: AbortSignal) =>
    request<T>(`/admin/api${path}`, { method: 'DELETE', signal }),
}
