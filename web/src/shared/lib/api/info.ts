import { userApi } from './http'

export interface Info {
  version: string | null
  username: string | null
  admin: boolean
  selected_target: string | null
  external_host: string | null
  ports: {
    ssh: number | null
    http: number | null
    mysql: number | null
    postgres: number | null
    kubernetes: number | null
  }
  minimize_password_login: boolean
  authorized_via_ticket: boolean
  authorized_via_sso_with_single_logout: boolean
  own_credential_management_allowed: boolean
  setup_state: { has_targets: boolean, has_users: boolean } | null
  // Base domain of the HTTP-proxy listener; null when proxy is off / unset.
  http_proxy_base_domain: string | null
  // When true, the web terminal renders a frontend-only operator-identity +
  // timestamp watermark overlay. Defaults to false.
  terminal_watermark_enabled: boolean
  // Configured site title; null uses the built-in "Gated".
  site_title?: string | null
}

export async function getInfo(signal?: AbortSignal): Promise<Info> {
  return userApi.get<Info>('/info', signal)
}
