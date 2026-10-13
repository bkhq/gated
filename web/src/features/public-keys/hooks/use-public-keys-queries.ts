import type { PublicKeyDraft } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { profileApi } from '@/shared/lib/api/profile'

export function usePublicKeys() {
  return useQuery({ queryKey: ['public-keys'], queryFn: async ({ signal }) => profileApi.publicKeys.list(signal) })
}

export function useRegisterPublicKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (draft: PublicKeyDraft) => profileApi.publicKeys.register(draft),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['public-keys'] }),
  })
}

export function useRemovePublicKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await profileApi.publicKeys.remove(id)
      return { id }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['public-keys'] }),
  })
}
