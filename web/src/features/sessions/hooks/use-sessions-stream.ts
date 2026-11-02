import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { useWebSocket } from '@/shared/hooks/use-websocket'

/**
 * Subscribe to `WS /admin/api/sessions/changes`. On any message, invalidate the
 * `['sessions']` query family so list views refetch and reflect the new state.
 * Mount once per page that needs live sessions; the WebSocket itself is closed
 * on unmount via AbortController.
 */
export function useSessionsStream(enabled = true): void {
  const qc = useQueryClient()
  const onMessage = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['sessions'] })
  }, [qc])
  useWebSocket({
    url: '/admin/api/sessions/changes',
    enabled,
    onMessage,
  })
}
