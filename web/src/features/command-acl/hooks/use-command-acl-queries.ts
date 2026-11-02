import type { CommandAclRule, CommandAclRuleRequest } from '@/shared/lib/api/command-acl'
import type { ApiError } from '@/shared/lib/api/http'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCommandAclRule,
  deleteCommandAclRule,
  listCommandAclRules,
  updateCommandAclRule,
} from '@/shared/lib/api/command-acl'

const KEY = ['command-acl-rules']

export function useCommandAclRules() {
  return useQuery<CommandAclRule[]>({
    queryKey: KEY,
    queryFn: async ({ signal }) => listCommandAclRules(signal),
  })
}

export function useCreateCommandAclRule() {
  const qc = useQueryClient()
  return useMutation<CommandAclRule, ApiError, CommandAclRuleRequest>({
    mutationFn: async body => createCommandAclRule(body),
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: KEY }) },
  })
}

export function useUpdateCommandAclRule() {
  const qc = useQueryClient()
  return useMutation<CommandAclRule, ApiError, { id: number, body: CommandAclRuleRequest }>({
    mutationFn: async ({ id, body }) => updateCommandAclRule(id, body),
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: KEY }) },
  })
}

export function useDeleteCommandAclRule() {
  const qc = useQueryClient()
  return useMutation<{ id: number }, ApiError, number>({
    mutationFn: async (id) => {
      await deleteCommandAclRule(id)
      return { id }
    },
    onSuccess: async () => { void qc.invalidateQueries({ queryKey: KEY }) },
  })
}
