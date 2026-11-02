import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { useWebSocket } from '@/shared/hooks/use-websocket'

// Backend frame payload is just the auth-state UUID (see
// `api_get_web_auth_requests_stream`). We don't need to inspect it — any frame
// means the pending list has changed for this user, so trigger a refetch.
export type AuthRequestStreamEvent = string

export interface UseAuthRequestsStreamOptions {
  enabled?: boolean
}

export function useAuthRequestsStream(options: UseAuthRequestsStreamOptions = {}) {
  const qc = useQueryClient()
  const onMessage = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['auth-requests'] })
  }, [qc])

  return useWebSocket<AuthRequestStreamEvent>({
    url: '/api/auth/web-auth-requests/stream',
    decode: raw => raw,
    onMessage,
    enabled: options.enabled ?? true,
  })
}
