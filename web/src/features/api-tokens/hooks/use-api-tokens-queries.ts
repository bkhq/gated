import type { ApiTokenCreation, ApiTokenDraft } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { profileApi } from '@/shared/lib/api/profile'

export function useApiTokens() {
  return useQuery({ queryKey: ['api-tokens'], queryFn: async ({ signal }) => profileApi.apiTokens.list(signal) })
}

export function useCreateApiToken() {
  const qc = useQueryClient()
  return useMutation<ApiTokenCreation, Error, ApiTokenDraft>({
    mutationFn: async draft => profileApi.apiTokens.create(draft),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  })
}

export function useRevokeApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await profileApi.apiTokens.revoke(id)
      return { id }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  })
}
