import type { Info } from '@/shared/lib/api/info'
import type { Target } from '@/shared/types/domain'

// The gateway selects the target from the protocol login name:
// `<user>#<target>` or `<user>:<target>` (crates/gated-common/src/auth/
// selector.rs). Host and per-protocol ports come from `GET /api/info`
// (`external_host`, `ports`); ports are null when the listener is disabled
// or the caller is unauthenticated.

export function gatewayHost(info: Info | undefined): string {
  if (info?.external_host)
    return info.external_host
  if (typeof window !== 'undefined' && window.location.hostname)
    return window.location.hostname
  return '<gateway-host>'
}

// A plain browser URL for an HTTP target: selects the target via the
// `<target>.<base_domain>` subdomain and carries the API token in a
// `?gated-token=` query param (the proxy accepts it for browser navigation,
// which can't set an Authorization header). Returns null unless this is an
// HTTP target with a configured public base domain.
export function buildBrowserUrl(
  target: Pick<Target, 'name' | 'kind'>,
  info: Info | undefined,
  token: string,
): string | null {
  if (target.kind !== 'http' || !info?.http_proxy_base_domain || !token)
    return null
  return `https://${target.name}.${info.http_proxy_base_domain}/?gated-token=${encodeURIComponent(token)}`
}

export function buildConnectCommand(
  target: Pick<Target, 'name' | 'kind'>,
  info: Info | undefined,
  // For HTTP targets only: when provided, the real API token is inlined into
  // the curl command instead of the `<API_TOKEN>` placeholder (handy while
  // testing). Ignored for ssh/mysql/postgres.
  httpToken?: string,
): string | null {
  const host = gatewayHost(info)
  const user = info?.username ?? '<user>'
  switch (target.kind) {
    case 'ssh': {
      const port = info?.ports.ssh
      return port ? `ssh ${user}:${target.name}@${host} -p ${port}` : null
    }
    case 'mysql': {
      const port = info?.ports.mysql
      return port ? `mysql -h ${host} -P ${port} -u '${user}#${target.name}' -p` : null
    }
    case 'postgres': {
      const port = info?.ports.postgres
      return port ? `psql -h ${host} -p ${port} -U '${user}#${target.name}' <database>` : null
    }
    case 'http': {
      // HTTP targets are served by the dedicated proxy listener and require
      // per-request auth — a Bearer API token (or mTLS client cert); without
      // it every request is 401. The frontend can't know the token (its secret
      // is shown only once at creation), so we default to an <API_TOKEN>
      // placeholder, or inline a token the user pasted for testing.
      const port = info?.ports.kubernetes
      if (!port)
        return null
      const token = httpToken?.trim() ? httpToken.trim() : '<API_TOKEN>'
      // Preferred: a public base domain is configured. We hit the apex
      // (the base_domain itself) and select the target via the X-Gated-Target
      // header. The apex is a one-level subdomain so it has a trusted public
      // cert — unlike `<target>.<base_domain>`, whose 2-level wildcard cert
      // can't be issued here (curl would need -k). Browser-open (subdomain +
      // ?gated-token=) is a separate path; see buildBrowserUrl.
      if (info?.http_proxy_base_domain) {
        return `curl -H 'Authorization: Bearer ${token}' -H 'X-Gated-Target: ${target.name}' https://${info.http_proxy_base_domain}/`
      }
      // Fallback: no base domain — select via the X-Gated-Target header against
      // the listener's own host:port (gated-protocol-http/src/resolver.rs).
      return `curl -H 'Authorization: Bearer ${token}' -H 'X-Gated-Target: ${target.name}' https://${host}:${port}/`
    }
    default:
      return null
  }
}
