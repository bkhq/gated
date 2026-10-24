import type { BackedParameters, BackedParametersUpdate } from '@/shared/lib/api/settings'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSettings, updateSettings } from '@/shared/lib/api/settings'

export type { BackedParameters, BackedParametersUpdate }

export function useBackendParameters() {
  return useQuery({
    queryKey: ['backend-parameters'],
    queryFn: async ({ signal }) => getSettings(signal),
  })
}

export function useUpdateBackendParameters() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: BackedParametersUpdate) => updateSettings(patch),
    onSuccess: async () => Promise.all([
      qc.invalidateQueries({ queryKey: ['backend-parameters'] }),
      // `/api/info` carries the site title shown by the shell.
      qc.invalidateQueries({ queryKey: ['info'] }),
    ]),
  })
}
