// Backend exposes auth-request endpoints on the user surface (`/api/auth/...`),
// not the admin surface. The dispatch payload referenced `/admin/api/auth/state`
// but that path does not exist on the admin OpenAPI; the only available routes
// are the per-user ones below. Generated `admin.types.ts` therefore has no
// AuthState schema — hand-written types here mirror
// `AuthStateResponseInternal` in `crates/gated-admin/src/http_service/api/auth.rs`.
import { userApi } from './http'

export type ApiAuthState
  = | 'NotStarted'
    | 'Failed'
    | 'PasswordNeeded'
    | 'OtpNeeded'
    | 'SsoNeeded'
    | 'WebUserApprovalNeeded'
    | 'PublicKeyNeeded'
    | 'Success'

export interface AuthStateResponse {
  id: string
  protocol: string
  address?: string | null
  started: string
  state: ApiAuthState
  identification_string: string
}

export async function listWebAuthRequests(signal?: AbortSignal): Promise<AuthStateResponse[]> {
  return userApi.get<AuthStateResponse[]>('/auth/web-auth-requests', signal)
}

export async function approveAuthRequest(id: string, signal?: AbortSignal): Promise<AuthStateResponse> {
  return userApi.post<AuthStateResponse>(`/auth/state/${encodeURIComponent(id)}/approve`, undefined, signal)
}

export async function rejectAuthRequest(id: string, signal?: AbortSignal): Promise<AuthStateResponse> {
  return userApi.post<AuthStateResponse>(`/auth/state/${encodeURIComponent(id)}/reject`, undefined, signal)
}
