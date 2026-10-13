export type TargetKind = 'ssh' | 'mysql' | 'postgres' | 'http'

// HTTP targets carry a flavor: `generic` is a plain reverse-proxy target,
// `kubernetes` enables the gateway's K8s-API-proxy behaviour (it maps to the
// backend `TargetHttpOptions.flavor` / `HttpProxyFlavor`). Only meaningful when
// `kind === 'http'`.
export type HttpFlavor = 'generic' | 'kubernetes'

export interface Target {
  id: string
  name: string
  kind: TargetKind
  host: string
  port: number
  user: string
  // Group id ('' when ungrouped) and its display name.
  group: string
  groupName?: string
  description?: string
  readonly?: boolean
  flavor?: HttpFlavor
}

export interface RecentActivityEntry {
  id: string
  user: string
  when: string
  action: string
  sessionId: string
}

export interface LiveSession {
  id: string
  user: string
  target: string
  protocol: string
  started: string
  duration: string
  state: 'live' | 'closed'
}

export interface User {
  id: string
  username: string
  name: string
  description?: string
  roles: string[]
  rate_limit_bytes_per_second?: number
}

export interface Role {
  id: string
  name: string
  description: string
  builtin?: boolean
}

export type AuthRequestState = 'pending' | 'approved' | 'rejected' | 'expired'

export interface AuthRequest {
  id: string
  protocol: 'ssh' | 'mysql' | 'postgres' | 'http'
  target: string
  from: string
  clientHint: string
  at: string
  state: AuthRequestState
  actor?: string
  createdAt: string
  expiresAt: string
  decidedAt?: string
  decidedBy?: string
  clientIp?: string
  clientLocation?: string
  relatedSessionId?: string
}

export function formatTicketUses(input: { usedCount: number, usesLimit: number }): string {
  return `${input.usedCount} / ${input.usesLimit}`
}

export function formatTicketExpiresIn(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now
  if (Number.isNaN(ms) || ms <= 0) {
    return '—'
  }
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) {
    return '< 1 m'
  }
  if (minutes < 60) {
    return `${minutes} m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rem = minutes - hours * 60
    return rem === 0 ? `${hours} h` : `${hours} h ${rem} m`
  }
  const days = Math.floor(hours / 24)
  return `${days} d`
}

export function isTicketExpiringSoon(ticket: { state: 'active' | 'consumed' | 'expired', expiresAt: string }, now: number = Date.now()): boolean {
  if (ticket.state !== 'active') {
    return false
  }
  const ms = new Date(ticket.expiresAt).getTime() - now
  return ms > 0 && ms < 60 * 60 * 1000
}

export function isTicketExpiryFuture(expiresAt: string, now: number = Date.now()): boolean {
  const ms = new Date(expiresAt).getTime()
  return Number.isFinite(ms) && ms > now
}

export interface Ticket {
  id: string
  name: string
  scope: string
  uses: string
  usedCount?: number
  usesLimit: number
  expiresIn: string
  expiresAt: string
  issuedBy: string
  issuedAt: string
  purpose: string
  state: 'active' | 'consumed' | 'expired'
}

export interface ApiToken {
  id: string
  name: string
  created: string
  expiresIn: string
}

export interface PublicKey {
  id: string
  name: string
  fingerprint: string
  added: string
  lastUsed: string
}

export interface OtpDevice {
  id: string
  name: string
  added: string
}

export type AccountKind
  = | 'ssh-password'
    | 'ssh-key'
    | 'db-password'
    | 'k8s-token'
    | 'k8s-client-cert'
    | 'http-headers'

export type DbEngine = 'mysql' | 'postgres'

export interface HttpHeaderCredential {
  name: string
  value: string
  sensitive?: boolean
}

export type AccountCredentials
  = | { kind: 'ssh-password', username: string, password: string }
    | { kind: 'ssh-key', username: string, private_key_pem: string, passphrase?: string }
    | { kind: 'db-password', engine: DbEngine, username: string, password: string }
    | { kind: 'k8s-token', token: string, ca_pem?: string, namespace?: string }
    | { kind: 'k8s-client-cert', client_certificate_pem: string, client_private_key_pem: string, passphrase?: string, ca_pem?: string, namespace?: string }
    | { kind: 'http-headers', headers: HttpHeaderCredential[] }

export interface Account {
  id: string
  name: string
  kind: AccountKind
  description: string
  referenceCount: number
  lastUsed: string | null
  rotationDueAt: string | null
  tags: string[]
}

export interface KnownHost {
  id: string
  host: string
  algo: string
  fingerprint: string
}

export interface TargetGroup {
  id: string
  name: string
  description: string
}

export interface AuditEntry {
  id: string
  at: string
  actor: string
  action: string
  // Structured fields recorded with the log line (LogEntry.values).
  values: Record<string, unknown>
  sessionId: string
  ageDays: number
}
