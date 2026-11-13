import type { Target } from '@/shared/types/domain'

/** Display address for a target; HTTP targets are addressed by URL and have no user or port. */
export function formatTargetAddress(target: Pick<Target, 'kind' | 'user' | 'host' | 'port'>): string {
  if (target.kind === 'http')
    return target.host
  const address = `${target.host}:${target.port}`
  return target.user ? `${target.user}@${address}` : address
}
