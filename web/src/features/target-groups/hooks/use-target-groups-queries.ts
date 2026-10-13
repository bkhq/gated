import type {
  ApiTargetGroup,
  ApiTargetGroupDataRequest,
} from '@/shared/lib/api/target-groups'
import type { TargetGroup } from '@/shared/types/domain'
import type { TargetGroupDraft } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createTargetGroup,
  deleteTargetGroup,
  getTargetGroup,
  listTargetGroups,
  updateTargetGroup,
} from '@/shared/lib/api/target-groups'

function adapt(item: ApiTargetGroup): TargetGroup {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
  }
}

function draftToApiRequest(draft: TargetGroupDraft | Partial<TargetGroup>, fallbackName?: string): ApiTargetGroupDataRequest {
  return {
    name: draft.name ?? fallbackName ?? '',
    description: draft.description ?? '',
  }
}

export function useTargetGroups() {
  return useQuery<TargetGroup[]>({
    queryKey: ['target-groups'],
    queryFn: async ({ signal }) => {
      const list = await listTargetGroups(signal)
      return list.map(adapt)
    },
  })
}

export function useCreateTargetGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (draft: TargetGroupDraft) => {
      const created = await createTargetGroup(draftToApiRequest(draft))
      return adapt(created)
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['target-groups'] }),
  })
}

export function useUpdateTargetGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string, patch: Partial<TargetGroup> }) => {
      // Backend update is PUT (full replace). Refetch existing record so a
      // partial patch from the UI doesn't blank fields we didn't touch.
      const existing = await getTargetGroup(id)
      const body: ApiTargetGroupDataRequest = {
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
      }
      const updated = await updateTargetGroup(id, body)
      return adapt(updated)
    },
    // Targets carry resolved group names.
    onSuccess: async () => Promise.all([
      qc.invalidateQueries({ queryKey: ['target-groups'] }),
      qc.invalidateQueries({ queryKey: ['targets'] }),
    ]),
  })
}

export function useDeleteTargetGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await deleteTargetGroup(id)
      return { id }
    },
    onSuccess: async () => Promise.all([
      qc.invalidateQueries({ queryKey: ['target-groups'] }),
      qc.invalidateQueries({ queryKey: ['targets'] }),
    ]),
  })
}
