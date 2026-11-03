import i18n from 'i18next'
import { toast } from 'sonner'
import { ApiError } from './api/http'
import { describeError } from './error-message'

/** Shows why an operation failed in the global toast. */
export function toastError(error: unknown) {
  // The re-login redirect already explains an expired session.
  if (error instanceof ApiError && error.sessionExpired)
    return
  const message = describeError(error, (key, options) => i18n.t(key, options))
  toast.error(message, { id: message })
}
