import { useQuery } from '@tanstack/react-query'
import { getInfo } from '@/shared/lib/api/info'

export function useInfo() {
  return useQuery({
    queryKey: ['info'],
    queryFn: async ({ signal }) => getInfo(signal),
    staleTime: 30_000,
    retry: false,
  })
}

export function useIsAdmin(): boolean {
  return useInfo().data?.admin ?? false
}
