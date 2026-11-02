import type { AsciiCastLine, RecordingStreamFrame } from '@/features/recordings/types'
import * as React from 'react'
import { parseRecordingStreamFrame } from '@/features/recordings/types'
import { useWebSocket } from '@/shared/hooks/use-websocket'
import { sessionMonitorUrl } from '@/shared/lib/api/sessions'

export interface SessionMonitorState {
  started: boolean
  live: boolean
  frames: AsciiCastLine[]
  ended: boolean
}

const IDLE_STATE: SessionMonitorState = {
  started: false,
  live: false,
  frames: [],
  ended: false,
}

export interface UseSessionMonitorResult extends SessionMonitorState {
  readyState: 'connecting' | 'open' | 'closed'
  lastError: Event | null
}

/**
 * Read-only live monitor for an active session's terminal output. The monitor
 * WebSocket emits the same `{ start, live }` / `{ data }` / `{ end }` frames as
 * the recording live stream, so it reuses `parseRecordingStreamFrame`. The
 * client -> server half is never used; nothing is sent.
 */
export function useSessionMonitorStream(
  sessionId: string | undefined,
  enabled: boolean,
): UseSessionMonitorResult {
  const socketEnabled = typeof sessionId === 'string' && enabled
  const streamKey = socketEnabled ? sessionId : null
  const [state, setState] = React.useState<SessionMonitorState>(IDLE_STATE)
  const [trackedKey, setTrackedKey] = React.useState<string | null>(streamKey)

  // Reset accumulated state during render when the session identity flips so
  // leftover frames from a prior session don't bleed into the next.
  if (trackedKey !== streamKey) {
    setTrackedKey(streamKey)
    setState(IDLE_STATE)
  }

  const onMessage = React.useCallback((frame: RecordingStreamFrame | null) => {
    if (frame === null)
      return
    setState((prev) => {
      if ('start' in frame)
        return { ...prev, started: true, live: frame.live }
      if ('data' in frame)
        return { ...prev, frames: [...prev.frames, frame.data] }
      if ('end' in frame)
        return { ...prev, ended: true }
      return prev
    })
  }, [])

  const { readyState, lastError } = useWebSocket<RecordingStreamFrame | null>({
    url: () => sessionMonitorUrl(sessionId ?? ''),
    decode: parseRecordingStreamFrame,
    onMessage,
    enabled: socketEnabled,
  })

  if (!socketEnabled) {
    return { ...IDLE_STATE, readyState: 'closed', lastError: null }
  }

  return { ...state, readyState, lastError }
}
