// Hand-maintained types + client for the unified command-records query.
// Mirrors crates/gated-admin/src/api/command_records.rs.

import { adminApi } from './http'

export type CommandRecordSource = 'shell' | 'sql'

/** One command record, unified across the shell-command and SQL audit streams. */
export interface CommandRecord {
  source: CommandRecordSource
  timestamp: string
  session_id: string
  target: string | null
  target_id: string | null
  user_id: string | null
  username: string | null
  /** The shell command line or the SQL query text. */
  command: string
  /** Shell only: `"exec"` | `"pty"`. */
  origin: string | null
  /** Shell command-ACL verdict: `"allow"` | `"deny"` | `"review"`. */
  acl_action: string | null
  acl_rule_id: number | null
  acl_rule_name: string | null
  /** Shell only: `"allowed"` | `"blocked"` | `"blocked-review-pending"`. */
  outcome: string | null
  /** SQL only: whether the statement executed successfully. */
  success: boolean | null
  /** SQL only: error text when the statement failed. */
  error: string | null
}

export interface CommandRecordsResponse {
  items: CommandRecord[]
  /** Total number of records matching the filters (before pagination). */
  total: number
  offset: number
  limit: number
}

export interface CommandRecordsQuery {
  session_id?: string
  user_id?: string
  username?: string
  target_id?: string
  source?: CommandRecordSource
  /** RFC3339 timestamp. */
  from?: string
  /** RFC3339 timestamp. */
  to?: string
  /** Case-insensitive substring over the command/query text. */
  q?: string
  limit?: number
  offset?: number
}

function toQueryString(query: CommandRecordsQuery): string {
  const params = new URLSearchParams()
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '')
      params.set(key, String(value))
  }
  add('session_id', query.session_id)
  add('user_id', query.user_id)
  add('username', query.username)
  add('target_id', query.target_id)
  add('source', query.source)
  add('from', query.from)
  add('to', query.to)
  add('q', query.q)
  add('limit', query.limit)
  add('offset', query.offset)
  const s = params.toString()
  return s.length > 0 ? `?${s}` : ''
}

export async function listCommandRecords(query: CommandRecordsQuery = {}, signal?: AbortSignal): Promise<CommandRecordsResponse> {
  return adminApi.get<CommandRecordsResponse>(`/command-records${toQueryString(query)}`, signal)
}
