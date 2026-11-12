import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { checkSession } from '@/shared/lib/api/auth'
import { ApiError } from '@/shared/lib/api/http'

const CHECK_INTERVAL_MS = 60_000

/**
 * Notices a browser session that expired while the page sat idle: asks the
 * gateway once a minute and when the tab becomes visible, and reloads the
 * signed-in state once the session is gone, which sends the user to the
 * login page. The check does not extend the session.
 */
export function useSessionWatch(enabled: boolean) {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    if (!enabled)
      return undefined
    let stopped = false
    const check = () => {
      checkSession().catch((error: unknown) => {
        if (!stopped && error instanceof ApiError && error.status === 401) {
          queryClient.removeQueries({ predicate: query => query.queryKey[0] !== 'info' })
          void queryClient.invalidateQueries({ queryKey: ['info'] })
        }
      })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible')
        check()
    }
    const timer = window.setInterval(check, CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, queryClient])
}
