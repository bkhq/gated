import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isServing, LOCK_STATUS_QUERY_KEY } from '@/shared/hooks/use-lock-status'
import { getLockStatus } from '@/shared/lib/api/encryption'
import { ApiError } from '@/shared/lib/api/http'
import { toastError } from '@/shared/lib/toast-error'

declare module '@tanstack/react-query' {
  interface Register {
    // `inlineError` marks failures the caller shows itself (a prompt that
    // stays open for another try); `true` covers every failure.
    mutationMeta: { inlineError?: boolean | ((error: unknown) => boolean) }
    queryMeta: { inlineError?: boolean | ((error: unknown) => boolean) }
  }
}

function shouldToast(error: unknown, inlineError: boolean | ((error: unknown) => boolean) | undefined): boolean {
  return typeof inlineError === 'function' ? !inlineError(error) : !inlineError
}

// While the gateway is locked, every API but lock-status answers 404, and
// while it restarts requests fail to connect. Those failures are expected:
// check the lock status once (shared by all failing requests), which also
// moves the boot gate to the unlock screen, and report only real failures.
function mayBeLocked(error: unknown): boolean {
  return (error instanceof ApiError && error.status === 404) || error instanceof TypeError
}

function report(client: QueryClient, error: unknown, toast = true): void {
  if (!mayBeLocked(error)) {
    if (toast)
      toastError(error)
    return
  }
  client.fetchQuery({
    queryKey: LOCK_STATUS_QUERY_KEY,
    queryFn: async ({ signal }) => getLockStatus(signal),
    staleTime: 2000,
    retry: false,
  }).then((status) => {
    if (toast && isServing(status))
      toastError(error)
  }, () => {})
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: 1,
      },
    },
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (shouldToast(error, mutation.meta?.inlineError))
          report(client, error)
      },
    }),
    queryCache: new QueryCache({
      // Background refetches keep showing the data they already have.
      onError: (error, query) => {
        report(client, error, query.state.data === undefined && shouldToast(error, query.meta?.inlineError))
      },
    }),
  })
  return client
}
