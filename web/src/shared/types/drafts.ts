import type {
  AccountCredentials,
  AccountKind,
  ApiToken,
  Role,
  Target,
  TargetGroup,
  Ticket,
  User,
} from './domain'
import type { TargetAccountBinding } from '@/shared/lib/api/targets'

// Credentials stored on the target itself instead of a bound account.
// A blank secret keeps the stored one on update.
export type InlineAuth
  = | { method: 'password', password: string }
    | { method: 'key', privateKey: string, passphrase: string }
    | { method: 'none' }
    | { method: 'bearer', token: string }

export type TargetDraft = Omit<Target, 'id'> & {
  // Omitted: keep bindings; []: inline credentials, bindings dropped.
  accounts?: TargetAccountBinding[]
  inlineAuth?: InlineAuth
}

export type UserDraft = Omit<User, 'id' | 'roles'> & {
  roles?: string[]
}

export interface UserReferences {
  roleCount: number
  liveSessionCount: number
  roles: string[]
}

export type RoleDraft = Pick<Role, 'name' | 'description' | 'allowFileTransfer'>

export interface RoleReferences {
  userCount: number
  accountCount: number
  targetCount: number
  liveSessionCount: number
  users: string[]
}

export interface TicketDraft {
  name: string
  scope: string
  usesLimit: number
  usedCount?: number
  expiresAt: string
  purpose?: string
  issuedBy?: string
  issuedAt?: string
  state?: Ticket['state']
}

export interface AccountDraft {
  name: string
  kind: AccountKind
  description: string
  credentials: AccountCredentials
  tags: string[]
  rotationDueAt?: string | null
}

export interface AccountReferences {
  targetCount: number
  roleCount: number
  targetNames: string[]
  roles: string[]
}

export interface AccountSecret {
  kind: AccountKind
  credentials: AccountCredentials
}

export type TargetGroupDraft = Pick<TargetGroup, 'name' | 'description'>

export interface ApiTokenDraft {
  name: string
  expiresIn: string
}

export interface ApiTokenCreation {
  token: ApiToken
  fullSecret: string
}

export interface PublicKeyDraft {
  name: string
  material: string
}

export interface OtpDeviceDraft {
  otp: string
}
