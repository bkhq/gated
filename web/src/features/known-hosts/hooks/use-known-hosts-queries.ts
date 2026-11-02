import type { SSHKnownHost } from '@/shared/lib/api/known-hosts'
import type { KnownHost } from '@/shared/types/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteKnownHost as deleteKnownHostApi,
  listKnownHosts,
} from '@/shared/lib/api/known-hosts'

// The key is shown as its raw base64 bytes (not a hashed fingerprint);
// truncation in the consumer page keeps the row readable.
function adapt(item: SSHKnownHost): KnownHost {
  return {
    id: item.id,
    host: item.port === 22 ? item.host : `${item.host}:${item.port}`,
    algo: item.key_type,
    fingerprint: item.key_base64,
  }
}

// Hand-rolled bounded concurrency: avoid stampeding the admin API when a user
// bulk-purges dozens of hosts at once. Mirrors the dispatch spec's "p-limit 5"
// guidance without pulling in a new dependency.
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = Array.from({ length: items.length })
  let cursor = 0
  const runnerCount = Math.min(limit, items.length)
  const runners = Array.from({ length: runnerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        await worker(items[index]!)
        results[index] = { status: 'fulfilled', value: undefined }
      }
      catch (err) {
        results[index] = { status: 'rejected', reason: err }
      }
    }
  })
  await Promise.all(runners)
  return results
}

export function useKnownHosts() {
  return useQuery<KnownHost[]>({
    queryKey: ['known-hosts'],
    queryFn: async ({ signal }) => {
      const list = await listKnownHosts(signal)
      return list.map(adapt)
    },
  })
}

export function useDeleteKnownHost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await deleteKnownHostApi(id)
      return { id }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['known-hosts'] }),
  })
}

export function useDeleteKnownHostsBatch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      // Backend has no batch endpoint; fan out with bounded concurrency.
      await runWithConcurrency(ids, 5, async id => deleteKnownHostApi(id))
      return { ids }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['known-hosts'] }),
  })
}
