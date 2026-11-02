import type { components } from './admin.types'
import { adminApi } from './http'

export type LogEntry = components['schemas']['LogEntry']
export type GetLogsRequest = components['schemas']['GetLogsRequest']

export async function getLogs(req: GetLogsRequest, signal?: AbortSignal, plane: 'session' | 'management' = 'session'): Promise<LogEntry[]> {
  return adminApi.post<LogEntry[]>(plane === 'management' ? '/management-audit' : '/logs', req, signal)
}
