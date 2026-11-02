import type { CommandRecordsQuery, CommandRecordsResponse } from '@/shared/lib/api/command-records'
import { useQuery } from '@tanstack/react-query'
import { listCommandRecords } from '@/shared/lib/api/command-records'

export function useCommandRecords(query: CommandRecordsQuery) {
  return useQuery<CommandRecordsResponse>({
    queryKey: ['command-records', query],
    queryFn: async ({ signal }) => listCommandRecords(query, signal),
    placeholderData: prev => prev,
  })
}
