import type { Target } from '@/shared/types/domain'

/** Display address for a target; HTTP targets are addressed by URL and have no user or port. */
export function formatTargetAddress(target: Pick<Target, 'kind' | 'user' | 'host' | 'port'>): string {
  return target.kind === 'http' ? target.host : `${target.user}@${target.host}:${target.port}`
}
