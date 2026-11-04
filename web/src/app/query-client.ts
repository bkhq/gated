import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
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

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: 1,
      },
    },
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (shouldToast(error, mutation.meta?.inlineError))
          toastError(error)
      },
    }),
    queryCache: new QueryCache({
      // Background refetches keep showing the data they already have.
      onError: (error, query) => {
        if (query.state.data === undefined && shouldToast(error, query.meta?.inlineError))
          toastError(error)
      },
    }),
  })
}
