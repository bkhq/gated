import { ApiError, extractMessage } from './api/http'

type Translate = (key: string, options?: Record<string, unknown>) => string

const STATUS_KEYS = new Set([400, 401, 403, 404, 409, 413, 422, 429])

/** The reason to show for a failed operation. */
export function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    const detail = extractMessage(error.body) ?? (/^HTTP \d+$/.test(error.message) ? undefined : error.message)
    if (detail)
      return detail
    const status = error.status
    if (STATUS_KEYS.has(status))
      return t(`errors.status.${status}`, { status })
    return t(status >= 500 ? 'errors.status.server' : 'errors.status.other', { status })
  }
  if (error instanceof Error && error.message)
    return error.message
  return t('errors.unknown')
}
