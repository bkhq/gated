export type TargetKind = 'ssh' | 'mysql' | 'postgres' | 'http' | 'rdp' | 'vnc'

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
  // Upstream TLS settings of HTTP/MySQL/PostgreSQL targets (admin data only).
  tls?: { mode: string, verify: boolean }
  // RDP only: Windows domain and upstream certificate verification.
  domain?: string
  verifyTls?: boolean
  // RDP/VNC only: keystrokes are left out of recordings unless this is on.
  recordKeystrokes?: boolean
  // Last reachability check; null when never checked.
  status?: TargetHealth | null
}

export interface TargetHealth {
  reachable: boolean
  latencyMs: number | null
  error: string | null
  checkedAt: string
}

export interface RecentActivityEntry {
  id: string
  user: string
  target?: string
  latest: string
  // `events.*` label keys with occurrence counts, in first-seen order.
  events: { key: string, count: number }[]
  // Empty for rows that group session-less entries by event.
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
  /** The ticket the session was opened with, if any. */
  ticketId?: string | null
}

export interface User {
  id: string
  username: string
  name: string
  description?: string
  roles: string[]
  rate_limit_bytes_per_second?: number
  /** Addresses and CIDR ranges the user is limited to; absent = anywhere. */
  allowed_ip_ranges?: string[]
}

export interface Role {
  id: string
  name: string
  description: string
  builtin?: boolean
  /** SFTP and the web file manager on this role's targets. */
  allowFileTransfer?: boolean
  /** Clipboard sync in RDP and VNC sessions on this role's targets. */
  allowClipboard?: boolean
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
  // Remaining uses; null when the ticket is unlimited.
  usesLeft: number | null
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
  publicKey: string
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
    | 'desktop-password'

export type DbEngine = 'mysql' | 'postgres'

export type SshKeyAlgorithm = 'ed25519' | 'rsa'

export interface HttpHeaderCredential {
  name: string
  value: string
  sensitive?: boolean | null
}

export type AccountCredentials
  = | { kind: 'ssh-password', username: string, password: string }
    // `generate` asks the server to create the key; `public_key_openssh` and
    // `fingerprint` are read-only and derived from the stored key.
    | { kind: 'ssh-key', username: string, private_key_pem: string, passphrase?: string | null, generate?: SshKeyAlgorithm | null, public_key_openssh?: string, fingerprint?: string }
    | { kind: 'db-password', engine: DbEngine, username: string, password: string }
    | { kind: 'k8s-token', token: string, ca_pem?: string | null, namespace?: string | null }
    | { kind: 'k8s-client-cert', client_certificate_pem: string, client_private_key_pem: string, passphrase?: string | null, ca_pem?: string | null, namespace?: string | null }
    | { kind: 'http-headers', headers: HttpHeaderCredential[] }
    // RDP sign-in (username, optional domain) or a VNC password (no username).
    | { kind: 'desktop-password', username: string, password: string, domain?: string | null }

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
  // Display form: `host` on port 22, `host:port` otherwise.
  host: string
  hostname: string
  port: number
  algo: string
  // The key's base64 blob (not a hashed fingerprint).
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
  target: string | null
  protocol: string | null
  clientAddress: string | null
  sessionStarted: string | null
  sessionEnded: string | null
  ageDays: number
}
