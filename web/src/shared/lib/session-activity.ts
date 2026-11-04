import { reportActivity } from './api/auth'

const MIN_INTERVAL_MS = 60_000
let lastReported = Number.NEGATIVE_INFINITY

/**
 * Tells the gateway the user navigated, at most once a minute. Other requests
 * extend the session by themselves, except the polled endpoints the gateway
 * excludes; a navigation served from cache sends none, hence this report.
 */
export function noteActivity() {
  const now = Date.now()
  if (now - lastReported < MIN_INTERVAL_MS)
    return
  lastReported = now
  // Signed out (login page) answers 401; nothing to extend then.
  reportActivity().catch(() => {})
}
