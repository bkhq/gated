import type { ApiError } from './http'
import type { components as UserComponents } from './user.types'
import { userApi } from './http'

export type DbSchemaList = UserComponents['schemas']['SchemaList']
export type DbTableList = UserComponents['schemas']['TableList']
export type DbColumnList = UserComponents['schemas']['ColumnList']
export type DbColumnInfo = UserComponents['schemas']['ColumnInfo']
export type DbTableInfo = UserComponents['schemas']['TableInfo']
export type DbQueryRequest = UserComponents['schemas']['QueryRequest']
export type DbQueryResponse = UserComponents['schemas']['QueryResponse']
export type DbQueryColumn = UserComponents['schemas']['QueryColumn']

// Backend's SchemaList.kind is generated as `string`. The actual emitted values
// are constrained to these two; narrow at the boundary so UI code can switch
// on them without re-validating.
export type DbKind = 'MySql' | 'Postgres'

export function asDbKind(kind: string): DbKind | null {
  return kind === 'MySql' || kind === 'Postgres' ? kind : null
}

function buildQuery(params: Record<string, string | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined)
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

export async function getDbSchemas(target: string, signal?: AbortSignal): Promise<DbSchemaList> {
  return userApi.get<DbSchemaList>(`/db/schemas/${encodeURIComponent(target)}`, signal)
}

export async function getDbTables(
  target: string,
  schema: string | undefined,
  signal?: AbortSignal,
): Promise<DbTableList> {
  const query = buildQuery({ schema })
  return userApi.get<DbTableList>(`/db/tables/${encodeURIComponent(target)}${query}`, signal)
}

export async function getDbColumns(
  target: string,
  schema: string | undefined,
  table: string,
  signal?: AbortSignal,
): Promise<DbColumnList> {
  const query = buildQuery({ schema, table })
  return userApi.get<DbColumnList>(`/db/columns/${encodeURIComponent(target)}${query}`, signal)
}

export async function runDbQuery(
  target: string,
  body: DbQueryRequest,
  signal?: AbortSignal,
): Promise<DbQueryResponse> {
  return userApi.post<DbQueryResponse>(`/db/query/${encodeURIComponent(target)}`, body, signal)
}

// Reads `retry_after` (seconds) out of a 429 DbError envelope. Returns null
// when the field is absent or non-numeric. Keeps ApiError-shape knowledge out
// of UI code.
export function dbRetryAfterSeconds(err: ApiError): number | null {
  const body = err.body
  if (body && typeof body === 'object' && 'retry_after' in body) {
    const value = body.retry_after
    if (typeof value === 'number' && Number.isFinite(value))
      return value
  }
  return null
}
