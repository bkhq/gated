import * as React from 'react'

export interface RateLimitCountdown {
  /** Seconds remaining; 0 means the limit has cleared. */
  seconds: number
  /** Convenience: true while seconds > 0. */
  active: boolean
  /** Start (or restart) the countdown at `retryAfter` seconds. */
  start: (retryAfter: number) => void
  /** Cancel an in-flight countdown immediately. */
  clear: () => void
}

const MIN_INTERVAL_MS = 1000

export function useRateLimitCountdown(): RateLimitCountdown {
  const [seconds, setSeconds] = React.useState(0)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const start = React.useCallback((retryAfter: number) => {
    stopTimer()
    // Clamp at 0 (server can theoretically send 0 or negative); cap raw value
    // — we don't validate an upper bound, only floor at zero.
    const initial = Math.max(0, Math.floor(retryAfter))
    setSeconds(initial)
    if (initial === 0)
      return
    timerRef.current = setInterval(() => {
      setSeconds((current) => {
        if (current <= 1) {
          stopTimer()
          return 0
        }
        return current - 1
      })
    }, MIN_INTERVAL_MS)
  }, [stopTimer])

  const clear = React.useCallback(() => {
    stopTimer()
    setSeconds(0)
  }, [stopTimer])

  React.useEffect(() => stopTimer, [stopTimer])

  return { seconds, active: seconds > 0, start, clear }
}
