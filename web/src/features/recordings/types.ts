// AsciiCast v2 line + WebSocket stream frame types for the recording player.
// The server emits these on `/admin/api/recordings/:id/cast` (newline-delimited
// JSON) and `/admin/api/recordings/:id/stream` (WS text frames). See docs/api.md
// §2.2 for the wire format.

export interface AsciiCastHeader {
  version: 2
  width: number
  height: number
  title?: string
  time?: number
}

export type AsciiCastEvent = [time: number, channel: 'i' | 'o' | 'e', data: string]

export type AsciiCastLine = AsciiCastHeader | AsciiCastEvent

export type RecordingStreamFrame
  = | { start: true, live: boolean }
    | { data: AsciiCastLine }
    | { end: true }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateAsciiCastLine(parsed: unknown): AsciiCastLine | null {
  if (Array.isArray(parsed)) {
    if (parsed.length !== 3)
      return null
    const [time, channel, data] = parsed
    if (typeof time !== 'number')
      return null
    if (channel !== 'i' && channel !== 'o' && channel !== 'e')
      return null
    if (typeof data !== 'string')
      return null
    return [time, channel, data]
  }
  if (isObject(parsed)) {
    if (parsed.version !== 2)
      return null
    const { width, height } = parsed
    if (typeof width !== 'number' || typeof height !== 'number')
      return null
    const header: AsciiCastHeader = { version: 2, width, height }
    if (typeof parsed.title === 'string')
      header.title = parsed.title
    if (typeof parsed.time === 'number')
      header.time = parsed.time
    return header
  }
  return null
}

export function parseAsciiCastLine(raw: string): AsciiCastLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  return validateAsciiCastLine(parsed)
}

export function parseRecordingStreamFrame(raw: string): RecordingStreamFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!isObject(parsed))
    return null
  if (parsed.start === true && typeof parsed.live === 'boolean')
    return { start: true, live: parsed.live }
  if (parsed.end === true)
    return { end: true }
  if ('data' in parsed) {
    const data = validateAsciiCastLine(parsed.data)
    if (data === null)
      return null
    return { data }
  }
  return null
}
