import type { AsciiCastLine, RecordingStreamFrame } from '@/features/recordings/types'
import * as React from 'react'
import { parseRecordingStreamFrame } from '@/features/recordings/types'
import { useWebSocket } from '@/shared/hooks/use-websocket'
import { recordingStreamUrl } from '@/shared/lib/api/recordings'

export interface RecordingStreamState {
  started: boolean
  live: boolean
  frames: AsciiCastLine[]
  ended: boolean
}

const IDLE_STATE: RecordingStreamState = {
  started: false,
  live: false,
  frames: [],
  ended: false,
}

export interface UseRecordingStreamResult extends RecordingStreamState {
  readyState: 'connecting' | 'open' | 'closed'
  lastError: Event | null
}

export function useRecordingStream(
  id: string | undefined,
  enabled: boolean,
): UseRecordingStreamResult {
  const socketEnabled = typeof id === 'string' && enabled
  const streamKey = socketEnabled ? id : null
  const [state, setState] = React.useState<RecordingStreamState>(IDLE_STATE)
  const [trackedKey, setTrackedKey] = React.useState<string | null>(streamKey)

  // Reset accumulated state during render when the stream identity flips —
  // leftover frames from a prior recording must not bleed into the next one.
  // React's recommended pattern over a reset effect (avoids extra commit).
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
    url: () => recordingStreamUrl(id ?? ''),
    decode: parseRecordingStreamFrame,
    onMessage,
    enabled: socketEnabled,
  })

  if (!socketEnabled) {
    return {
      ...IDLE_STATE,
      readyState: 'closed',
      lastError: null,
    }
  }

  return { ...state, readyState, lastError }
}
