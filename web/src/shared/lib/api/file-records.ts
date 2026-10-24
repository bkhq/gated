// Client for the file operation audit query (crates/gated-admin/src/api/file_records.rs).

import type { components } from './admin.types'
import { adminApi } from './http'

export type FileRecord = components['schemas']['FileRecord']
export type FileRecordsResponse = components['schemas']['FileRecordsResponse']
export type FileRecordOrigin = 'sftp' | 'web'

export interface FileRecordsQuery {
  session_id?: string
  username?: string
  target_id?: string
  origin?: FileRecordOrigin
  operation?: string
  /** RFC3339 timestamp. */
  from?: string
  /** RFC3339 timestamp. */
  to?: string
  /** Case-insensitive substring over the path and the rename destination. */
  q?: string
  limit?: number
  offset?: number
}

export async function listFileRecords(query: FileRecordsQuery = {}, signal?: AbortSignal): Promise<FileRecordsResponse> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '')
      params.set(key, String(value))
  }
  const s = params.toString()
  return adminApi.get<FileRecordsResponse>(`/file-records${s ? `?${s}` : ''}`, signal)
}
