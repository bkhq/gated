/**
 * Binary frame codec for the gated terminal WebSocket protocol.
 *
 * Wire format: every binary frame is `[msgType: u8, payload: bytes]`.
 *
 *   0x00 DATA              bidirectional   raw terminal bytes
 *   0x01 RESIZE            client → server JSON `{ cols, rows }`
 *   0x02 STATUS            server → client JSON `{ status, message }`
 *   0x03 HOST_KEY_VERIFY   server: JSON `{ status: "host_key_verify",
 *                                          algorithm, key_base64 }`
 *                          client: JSON `{ accepted: boolean }`  (SSH only)
 *
 * Status set:
 *   SSH      info | connected | closed | error | rate_limited
 *   MySQL    connected | error | rate_limited
 *   Postgres connected | error | rate_limited
 *
 * Backend types for resize: SSH parses `cols`/`rows` as `u32`; MySQL and
 * Postgres parse them as `u16`. The JSON wire format is the same — values
 * outside the host's native range are silently ignored by the server, so the
 * caller must clamp before sending (see {@link clampResize}).
 *
 * See `crates/gated-admin/src/http_service/api/ssh_terminal.rs` and
 * `db_terminal.rs` for the server side.
 */

export const MSG_DATA = 0x00
export const MSG_RESIZE = 0x01
export const MSG_STATUS = 0x02
export const MSG_HOST_KEY_VERIFY = 0x03

export type TerminalKind = 'ssh' | 'mysql' | 'postgres'

export interface StatusPayload {
  status: string
  message: string
}

export interface HostKeyVerifyPrompt {
  algorithm: string
  keyBase64: string
}

export type ServerFrame
  = | { type: 'data', payload: Uint8Array }
    | { type: 'status', payload: StatusPayload }
    | { type: 'host_key_verify', payload: HostKeyVerifyPrompt }
    | { type: 'unknown', msgType: number }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: false })

function prefix(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length)
  out[0] = type
  out.set(body, 1)
  return out
}

function jsonFrame(type: number, value: unknown): Uint8Array {
  return prefix(type, textEncoder.encode(JSON.stringify(value)))
}

/** Encode a 0x00 DATA frame carrying raw terminal input bytes. */
export function encodeData(payload: Uint8Array): Uint8Array {
  return prefix(MSG_DATA, payload)
}

/**
 * Encode a 0x01 RESIZE frame. The caller is responsible for clamping `cols`
 * and `rows` to the host's native integer range — use {@link clampResize}.
 */
export function encodeResize(cols: number, rows: number): Uint8Array {
  return jsonFrame(MSG_RESIZE, { cols, rows })
}

const U16_MAX = 0xFFFF
const U32_MAX = 0xFFFFFFFF

/**
 * Clamp `cols`/`rows` to the host's native range. SSH accepts u32; MySQL and
 * Postgres accept u16. Floors fractional values and forces at least 1.
 */
export function clampResize(
  cols: number,
  rows: number,
  kind: TerminalKind,
): { cols: number, rows: number } {
  const max = kind === 'ssh' ? U32_MAX : U16_MAX
  return { cols: clamp(cols, max), rows: clamp(rows, max) }
}

function clamp(n: number, max: number): number {
  if (!Number.isFinite(n))
    return 1
  const floored = Math.floor(n)
  if (floored < 1)
    return 1
  if (floored > max)
    return max
  return floored
}

/** Encode a 0x03 HOST_KEY_VERIFY response (SSH only). */
export function encodeHostKeyVerifyResponse(accepted: boolean): Uint8Array {
  return jsonFrame(MSG_HOST_KEY_VERIFY, { accepted })
}

function toUint8(input: ArrayBuffer | ArrayBufferView | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array)
    return input
  if (ArrayBuffer.isView(input))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return new Uint8Array(input)
}

function tryParseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(bytes))
  }
  catch {
    return null
  }
}

function isStatusPayload(value: unknown): value is StatusPayload {
  if (typeof value !== 'object' || value === null)
    return false
  const v = value as Record<string, unknown>
  return typeof v.status === 'string' && typeof v.message === 'string'
}

interface RawHostKeyPrompt {
  algorithm: string
  key_base64: string
}

function isRawHostKeyPrompt(value: unknown): value is RawHostKeyPrompt {
  if (typeof value !== 'object' || value === null)
    return false
  const v = value as Record<string, unknown>
  return typeof v.algorithm === 'string' && typeof v.key_base64 === 'string'
}

/**
 * Decode a server-sent binary frame. Returns `null` if the input is empty or
 * the payload fails JSON validation for its frame type. Unknown msg types
 * surface as `{ type: 'unknown' }` so callers can log them without crashing.
 */
export function decodeFrame(
  input: ArrayBuffer | ArrayBufferView | Uint8Array,
): ServerFrame | null {
  const bytes = toUint8(input)
  if (bytes.length === 0)
    return null
  const msgType = bytes[0] as number
  const payload = bytes.subarray(1)
  switch (msgType) {
    case MSG_DATA:
      return { type: 'data', payload }
    case MSG_STATUS: {
      const parsed = tryParseJson(payload)
      return isStatusPayload(parsed) ? { type: 'status', payload: parsed } : null
    }
    case MSG_HOST_KEY_VERIFY: {
      const parsed = tryParseJson(payload)
      if (!isRawHostKeyPrompt(parsed))
        return null
      return {
        type: 'host_key_verify',
        payload: { algorithm: parsed.algorithm, keyBase64: parsed.key_base64 },
      }
    }
    default:
      return { type: 'unknown', msgType }
  }
}
