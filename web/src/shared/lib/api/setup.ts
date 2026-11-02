import { userApi } from './http'

export interface SetupStatus {
  needs_setup: boolean
}

export interface SetupInitRequest {
  bootstrap_token: string
  username: string
  password: string
}

export async function getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  return userApi.get<SetupStatus>('/admin/setup/status', signal)
}

export async function initSetup(req: SetupInitRequest, signal?: AbortSignal): Promise<void> {
  await userApi.post<unknown>('/admin/setup/init', req, signal)
}
