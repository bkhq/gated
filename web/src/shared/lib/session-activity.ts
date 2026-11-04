import { reportActivity } from './api/auth'

const MIN_INTERVAL_MS = 60_000
let lastReported = Number.NEGATIVE_INFINITY

/**
 * Tells the gateway the user navigated or acted, at most once a minute. Only
 * this extends the browser session; background requests such as polling do not.
 */
export function noteActivity() {
  const now = Date.now()
  if (now - lastReported < MIN_INTERVAL_MS)
    return
  lastReported = now
  // Signed out (login page) answers 401; nothing to extend then.
  reportActivity().catch(() => {})
}
