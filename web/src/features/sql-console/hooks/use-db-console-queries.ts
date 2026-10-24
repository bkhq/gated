import type {
  DbColumnList,
  DbQueryRequest,
  DbQueryResponse,
  DbSchemaList,
  DbTableList,
} from '@/shared/lib/api/db-console'
import type { ApiError } from '@/shared/lib/api/http'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  getDbColumns,
  getDbSchemas,
  getDbTables,
  runDbQuery,
} from '@/shared/lib/api/db-console'

export function useDbSchemas(target: string) {
  return useQuery<DbSchemaList, ApiError>({
    queryKey: ['db', target, 'schemas'],
    queryFn: async ({ signal }) => getDbSchemas(target, signal),
    enabled: !!target,
  })
}

export function useDbTables(target: string, schema: string | undefined) {
  return useQuery<DbTableList, ApiError>({
    queryKey: ['db', target, 'tables', schema ?? null],
    queryFn: async ({ signal }) => getDbTables(target, schema, signal),
    enabled: !!target && !!schema,
  })
}

export function useDbColumns(target: string, schema: string | undefined, table: string) {
  return useQuery<DbColumnList, ApiError>({
    queryKey: ['db', target, 'columns', schema ?? null, table],
    queryFn: async ({ signal }) => getDbColumns(target, schema, table, signal),
    enabled: !!target && !!schema && !!table,
  })
}

export function useRunDbQuery(target: string) {
  return useMutation<DbQueryResponse, ApiError, DbQueryRequest>({
    mutationFn: async body => runDbQuery(target, body),
  })
}
