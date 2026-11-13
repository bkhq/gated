import type { TargetKind } from '@/shared/types/domain'

/** Target kind as the claim endpoint reports it. */
export type ClaimedKind = 'Ssh' | 'MySql' | 'Postgres' | 'Http' | 'Rdp' | 'Vnc'

export interface Endpoint {
  host: string | null
  ports: { ssh: number | null, mysql: number | null, postgres: number | null }
}

/**
 * The recipient's link. The secret travels in the fragment, which browsers
 * never send to the server, so opening the link (or a chat app previewing
 * it) consumes nothing; the page posts the secret to claim the ticket.
 */
export function claimLink(origin: string, secret: string): string {
  return `${origin}/ui/ticket#${encodeURIComponent(secret)}`
}

export function secretFromHash(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''))
  }
  catch {
    return ''
  }
}

/** The user name a ticket signs in with over SSH, MySQL and PostgreSQL. */
export function ticketUser(secret: string): string {
  return `ticket-${secret}`
}

/** A command line for the target, or null when the kind has none or the gateway host is unknown. */
export function connectionCommand(kind: TargetKind, endpoint: Endpoint, secret: string): string | null {
  const host = endpoint.host
  if (!host)
    return null
  const user = ticketUser(secret)
  switch (kind) {
    case 'ssh':
      return endpoint.ports.ssh === null ? null : `ssh -p ${endpoint.ports.ssh} ${user}@${host}`
    case 'mysql':
      return endpoint.ports.mysql === null ? null : `mysql -h ${host} -P ${endpoint.ports.mysql} -u ${user} -p`
    case 'postgres':
      return endpoint.ports.postgres === null ? null : `psql -h ${host} -p ${endpoint.ports.postgres} -U ${user}`
    case 'http':
    case 'rdp':
    case 'vnc':
      return null
  }
}

/** Where the browser goes once the ticket signed it in. */
export function claimDestination(kind: ClaimedKind, targetName: string): string {
  const name = encodeURIComponent(targetName)
  switch (kind) {
    case 'Ssh': return `/ui/terminal/ssh/${name}`
    case 'MySql':
    case 'Postgres': return `/ui/db/${name}`
    case 'Rdp':
    case 'Vnc': return `/ui/desktop/${name}`
    case 'Http': return '/ui/targets'
  }
}
