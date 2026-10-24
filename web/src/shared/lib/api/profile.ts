import type { components } from './user.types'
import type {
  ApiToken,
  OtpDevice,
  PublicKey,
  Ticket,
} from '@/shared/types/domain'
import type { ApiTokenCreation, ApiTokenDraft, OtpDeviceDraft, PublicKeyDraft } from '@/shared/types/drafts'
import { userApi } from './http'

type ExistingApiToken = components['schemas']['ExistingApiToken']
type NewApiToken = components['schemas']['NewApiToken']
type TokenAndSecret = components['schemas']['TokenAndSecret']
type CredentialsState = components['schemas']['CredentialsState']
type ExistingPublicKeyCredential = components['schemas']['ExistingPublicKeyCredential']
type NewPublicKeyCredential = components['schemas']['NewPublicKeyCredential']
type ExistingOtpCredential = components['schemas']['ExistingOtpCredential']
type ConfirmOtpCredential = components['schemas']['ConfirmOtpCredential']
type BeginOtpEnrollment = components['schemas']['BeginOtpEnrollment']
type ChangePasswordRequest = components['schemas']['ChangePasswordRequest']
type ExistingSsoCredential = components['schemas']['ExistingSsoCredential']
type NewProfileTicket = components['schemas']['NewProfileTicket']
type ProfileTicketAndSecret = components['schemas']['ProfileTicketAndSecret']
export type SessionSnapshot = components['schemas']['SessionSnapshot']
export type ExistingProfileTicket = components['schemas']['ExistingProfileTicket']
export type SsoBinding = ExistingSsoCredential

const FAR_FUTURE = '9999-12-31T23:59:59.000Z'
const DAY_MS = 24 * 60 * 60 * 1000

function dateOnly(value?: string | null): string {
  if (!value)
    return ''
  return value.slice(0, 10)
}

function isoOrUndefined(value?: string | null): string | undefined {
  return value ?? undefined
}

function humanizeExpiryFromIso(iso?: string | null): string {
  if (!iso)
    return 'never'
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms))
    return 'never'
  if (ms - Date.UTC(9999, 0, 1) >= 0)
    return 'never'
  const diff = ms - Date.now()
  if (diff <= 0)
    return '0d'
  const days = Math.ceil(diff / DAY_MS)
  return `${days}d`
}

function parseExpiresInToIso(value: string): string {
  if (value === 'never')
    return FAR_FUTURE
  const match = /^(\d+)d$/.exec(value)
  if (match) {
    const days = Number.parseInt(match[1]!, 10)
    return new Date(Date.now() + days * DAY_MS).toISOString()
  }
  // Fallback: 90 days
  return new Date(Date.now() + 90 * DAY_MS).toISOString()
}

function tokenFromApi(api: ExistingApiToken): ApiToken {
  return {
    id: api.id,
    name: api.label,
    created: dateOnly(api.created),
    expiresIn: humanizeExpiryFromIso(api.expiry),
  }
}

function publicKeyFromApi(api: ExistingPublicKeyCredential): PublicKey {
  return {
    id: api.id,
    name: api.label,
    fingerprint: api.abbreviated,
    added: dateOnly(isoOrUndefined(api.date_added)),
    lastUsed: api.last_used ? dateOnly(api.last_used) : 'never',
  }
}

function otpFromApi(api: ExistingOtpCredential): OtpDevice {
  // Backend does not persist a name on OTP credentials — display default.
  return {
    id: api.id,
    name: 'TOTP',
    added: '',
  }
}

export function ticketFromApi(api: ExistingProfileTicket, issuedBy: string): Ticket {
  const usesLimit = api.uses_left ?? 0
  const expiresAt = api.expiry ?? ''
  const expired = expiresAt !== '' && new Date(expiresAt).getTime() <= Date.now()
  return {
    id: api.id,
    name: api.description || api.target,
    scope: api.target,
    usesLeft: api.uses_left ?? null,
    usesLimit,
    expiresIn: humanizeExpiryFromIso(api.expiry),
    expiresAt,
    issuedBy,
    issuedAt: api.created,
    purpose: api.description,
    state: expired ? 'expired' : 'active',
  }
}

export const profileApi = {
  async changePassword(body: ChangePasswordRequest): Promise<void> {
    await userApi.post('/profile/credentials/password', body)
  },
  apiTokens: {
    async list(signal?: AbortSignal): Promise<ApiToken[]> {
      const data = await userApi.get<ExistingApiToken[]>('/profile/api-tokens', signal)
      return data.map(item => tokenFromApi(item))
    },
    async create(draft: ApiTokenDraft, signal?: AbortSignal): Promise<ApiTokenCreation> {
      const body: NewApiToken = {
        label: draft.name,
        expiry: parseExpiresInToIso(draft.expiresIn),
      }
      const response = await userApi.post<TokenAndSecret>('/profile/api-tokens', body, signal)
      return {
        token: { ...tokenFromApi(response.token), expiresIn: draft.expiresIn },
        fullSecret: response.secret,
      }
    },
    async revoke(id: string, signal?: AbortSignal): Promise<void> {
      await userApi.delete<void>(`/profile/api-tokens/${id}`, signal)
    },
  },

  publicKeys: {
    async list(signal?: AbortSignal): Promise<PublicKey[]> {
      const state = await userApi.get<CredentialsState>('/profile/credentials', signal)
      return state.public_keys.map(publicKeyFromApi)
    },
    async register(draft: PublicKeyDraft, signal?: AbortSignal): Promise<PublicKey> {
      const body: NewPublicKeyCredential = {
        label: draft.name,
        openssh_public_key: draft.material,
      }
      const created = await userApi.post<ExistingPublicKeyCredential>('/profile/credentials/public-keys', body, signal)
      return publicKeyFromApi(created)
    },
    async remove(id: string, signal?: AbortSignal): Promise<void> {
      await userApi.delete<void>(`/profile/credentials/public-keys/${id}`, signal)
    },
  },

  otpDevices: {
    async list(signal?: AbortSignal): Promise<OtpDevice[]> {
      const state = await userApi.get<CredentialsState>('/profile/credentials', signal)
      return state.otp.map(otpFromApi)
    },
    async begin(): Promise<BeginOtpEnrollment> {
      return userApi.post('/profile/credentials/otp/begin')
    },
    async add(draft: OtpDeviceDraft, signal?: AbortSignal): Promise<OtpDevice> {
      const body: ConfirmOtpCredential = { otp: draft.otp }
      const created = await userApi.post<ExistingOtpCredential>('/profile/credentials/otp', body, signal)
      return otpFromApi(created)
    },
    async remove(id: string, signal?: AbortSignal): Promise<void> {
      await userApi.delete<void>(`/profile/credentials/otp/${id}`, signal)
    },
  },

  tickets: {
    async list(signal?: AbortSignal): Promise<Ticket[]> {
      const data = await userApi.get<ExistingProfileTicket[]>('/profile/tickets', signal)
      return data.map(item => ticketFromApi(item, ''))
    },
    async create(body: NewProfileTicket, signal?: AbortSignal): Promise<ProfileTicketAndSecret> {
      return userApi.post<ProfileTicketAndSecret>('/profile/tickets', body, signal)
    },
    async remove(id: string, signal?: AbortSignal): Promise<void> {
      await userApi.delete<void>(`/profile/tickets/${encodeURIComponent(id)}`, signal)
    },
  },

  sessions: {
    async list(signal?: AbortSignal): Promise<SessionSnapshot[]> {
      return userApi.get<SessionSnapshot[]>('/profile/sessions', signal)
    },
  },

  sso: {
    async list(signal?: AbortSignal): Promise<SsoBinding[]> {
      const state = await userApi.get<CredentialsState>('/profile/credentials', signal)
      return state.sso
    },
  },
}
