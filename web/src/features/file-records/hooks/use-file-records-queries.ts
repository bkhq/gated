import type { FileRecordsQuery, FileRecordsResponse } from '@/shared/lib/api/file-records'
import { useQuery } from '@tanstack/react-query'
import { listFileRecords } from '@/shared/lib/api/file-records'

export function useFileRecords(query: FileRecordsQuery) {
  return useQuery<FileRecordsResponse>({
    queryKey: ['file-records', query],
    queryFn: async ({ signal }) => listFileRecords(query, signal),
    placeholderData: prev => prev,
  })
}
