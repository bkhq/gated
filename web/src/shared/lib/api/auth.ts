import type { components } from './user.types'
import { ApiError, userApi } from './http'

export type ApiAuthState = components['schemas']['ApiAuthState']
export type LoginRequest = components['schemas']['LoginRequest']
export type OtpLoginRequest = components['schemas']['OtpLoginRequest']
export type LoginFailureResponse = components['schemas']['LoginFailureResponse']
export type AuthStateResponse = components['schemas']['AuthStateResponseInternal']

export async function login(req: LoginRequest, signal?: AbortSignal): Promise<void> {
  await userApi.post<void>('/auth/login', req, signal)
}

export async function submitOtp(req: OtpLoginRequest, signal?: AbortSignal): Promise<void> {
  await userApi.post<void>('/auth/otp', req, signal)
}

export async function logout(signal?: AbortSignal): Promise<void> {
  await userApi.post<void>('/auth/logout', undefined, signal)
}

// Finish a login whose last factor was granted out of band (web approval).
export async function continueAuth(signal?: AbortSignal): Promise<AuthStateResponse> {
  return userApi.post<AuthStateResponse>('/auth/state/continue', undefined, signal)
}

export async function getAuthState(signal?: AbortSignal): Promise<AuthStateResponse | null> {
  try {
    return await userApi.get<AuthStateResponse>('/auth/state', signal)
  }
  catch (err) {
    if (err instanceof ApiError && err.status === 404)
      return null
    throw err
  }
}
