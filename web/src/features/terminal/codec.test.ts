import { describe, expect, it } from 'vitest'
import {
  clampResize,
  decodeFrame,
  encodeData,
  encodeHostKeyVerifyResponse,
  encodeResize,
  MSG_DATA,
  MSG_HOST_KEY_VERIFY,
  MSG_RESIZE,
  MSG_STATUS,
} from './codec'

const decoder = new TextDecoder()

function bodyAsJson(frame: Uint8Array): unknown {
  return JSON.parse(decoder.decode(frame.subarray(1)))
}

describe('encode', () => {
  it('encodeData prepends 0x00 and preserves payload bytes', () => {
    const payload = new Uint8Array([0x68, 0x69, 0x0A]) // "hi\n"
    const frame = encodeData(payload)
    expect(frame[0]).toBe(MSG_DATA)
    expect(frame.subarray(1)).toEqual(payload)
  })

  it('encodeData handles empty payload (still prefixes msg type)', () => {
    const frame = encodeData(new Uint8Array(0))
    expect(frame).toEqual(new Uint8Array([MSG_DATA]))
  })

  it('encodeResize emits a 0x01 frame with JSON {cols, rows}', () => {
    const frame = encodeResize(120, 40)
    expect(frame[0]).toBe(MSG_RESIZE)
    expect(bodyAsJson(frame)).toEqual({ cols: 120, rows: 40 })
  })

  it('encodeHostKeyVerifyResponse emits 0x03 with {accepted}', () => {
    const yes = encodeHostKeyVerifyResponse(true)
    expect(yes[0]).toBe(MSG_HOST_KEY_VERIFY)
    expect(bodyAsJson(yes)).toEqual({ accepted: true })

    const no = encodeHostKeyVerifyResponse(false)
    expect(no[0]).toBe(MSG_HOST_KEY_VERIFY)
    expect(bodyAsJson(no)).toEqual({ accepted: false })
  })
})

describe('clampResize', () => {
  it('passes valid sizes through unchanged', () => {
    expect(clampResize(80, 24, 'ssh')).toEqual({ cols: 80, rows: 24 })
    expect(clampResize(80, 24, 'mysql')).toEqual({ cols: 80, rows: 24 })
    expect(clampResize(80, 24, 'postgres')).toEqual({ cols: 80, rows: 24 })
  })

  it('clamps mysql/postgres to u16 max', () => {
    expect(clampResize(70000, 24, 'mysql')).toEqual({ cols: 0xFFFF, rows: 24 })
    expect(clampResize(80, 70000, 'postgres')).toEqual({ cols: 80, rows: 0xFFFF })
  })

  it('clamps ssh to u32 max', () => {
    expect(clampResize(2 ** 33, 24, 'ssh')).toEqual({ cols: 0xFFFFFFFF, rows: 24 })
    // a value u16 would clamp but u32 accepts
    expect(clampResize(70000, 70000, 'ssh')).toEqual({ cols: 70000, rows: 70000 })
  })

  it('forces a minimum of 1', () => {
    expect(clampResize(0, 0, 'ssh')).toEqual({ cols: 1, rows: 1 })
    expect(clampResize(-5, 24, 'mysql')).toEqual({ cols: 1, rows: 24 })
  })

  it('floors fractional values and recovers from NaN', () => {
    expect(clampResize(80.9, 24.4, 'ssh')).toEqual({ cols: 80, rows: 24 })
    expect(clampResize(Number.NaN, 24, 'ssh')).toEqual({ cols: 1, rows: 24 })
    expect(clampResize(Number.POSITIVE_INFINITY, 24, 'ssh')).toEqual({ cols: 1, rows: 24 })
  })
})

describe('decodeFrame', () => {
  function frameWith(type: number, jsonValue: unknown): Uint8Array {
    const body = new TextEncoder().encode(JSON.stringify(jsonValue))
    const buf = new Uint8Array(1 + body.length)
    buf[0] = type
    buf.set(body, 1)
    return buf
  }

  it('returns null for an empty buffer', () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull()
  })

  it('decodes a DATA frame and exposes the raw payload slice', () => {
    const buf = new Uint8Array([MSG_DATA, 0x41, 0x42, 0x43])
    const frame = decodeFrame(buf)
    expect(frame?.type).toBe('data')
    if (frame?.type === 'data')
      expect(frame.payload).toEqual(new Uint8Array([0x41, 0x42, 0x43]))
  })

  it('decodes a DATA frame with empty payload', () => {
    const frame = decodeFrame(new Uint8Array([MSG_DATA]))
    expect(frame?.type).toBe('data')
    if (frame?.type === 'data')
      expect(frame.payload.length).toBe(0)
  })

  it('decodes a STATUS frame into { status, message }', () => {
    const buf = frameWith(MSG_STATUS, { status: 'connected', message: 'SSH session established' })
    const frame = decodeFrame(buf)
    expect(frame).toEqual({
      type: 'status',
      payload: { status: 'connected', message: 'SSH session established' },
    })
  })

  it('exposes server status strings as-is (info/closed/error/rate_limited)', () => {
    for (const status of ['info', 'closed', 'error', 'rate_limited']) {
      const buf = frameWith(MSG_STATUS, { status, message: 'x' })
      const frame = decodeFrame(buf)
      expect(frame?.type).toBe('status')
      if (frame?.type === 'status')
        expect(frame.payload.status).toBe(status)
    }
  })

  it('rejects a STATUS frame missing required fields', () => {
    expect(decodeFrame(frameWith(MSG_STATUS, { status: 'error' }))).toBeNull()
    expect(decodeFrame(frameWith(MSG_STATUS, { message: 'x' }))).toBeNull()
    expect(decodeFrame(frameWith(MSG_STATUS, null))).toBeNull()
  })

  it('decodes a HOST_KEY_VERIFY prompt into camelCase fields', () => {
    const buf = frameWith(MSG_HOST_KEY_VERIFY, {
      status: 'host_key_verify',
      algorithm: 'ssh-ed25519',
      key_base64: 'AAAAC3NzaC1lZDI1NTE5AAAAIDxx',
    })
    const frame = decodeFrame(buf)
    expect(frame).toEqual({
      type: 'host_key_verify',
      payload: { algorithm: 'ssh-ed25519', keyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIDxx' },
    })
  })

  it('rejects a HOST_KEY_VERIFY frame with missing key_base64', () => {
    const buf = frameWith(MSG_HOST_KEY_VERIFY, { algorithm: 'ssh-ed25519' })
    expect(decodeFrame(buf)).toBeNull()
  })

  it('returns null for malformed JSON in a STATUS frame', () => {
    const buf = new Uint8Array([MSG_STATUS, 0x7B, 0x6E, 0x6F, 0x74]) // "{not"
    expect(decodeFrame(buf)).toBeNull()
  })

  it('surfaces an unknown msg type without throwing', () => {
    const buf = new Uint8Array([0x99, 0x01, 0x02])
    expect(decodeFrame(buf)).toEqual({ type: 'unknown', msgType: 0x99 })
  })

  it('accepts an ArrayBuffer input (WebSocket binaryType=arraybuffer)', () => {
    const src = new Uint8Array([MSG_DATA, 0x41])
    const frame = decodeFrame(src.buffer)
    expect(frame?.type).toBe('data')
  })

  it('accepts a DataView input', () => {
    const src = new Uint8Array([MSG_DATA, 0x41, 0x42])
    const view = new DataView(src.buffer, 0, src.byteLength)
    const frame = decodeFrame(view)
    expect(frame?.type).toBe('data')
    if (frame?.type === 'data')
      expect(frame.payload).toEqual(new Uint8Array([0x41, 0x42]))
  })
})

describe('round-trip', () => {
  it('encodeResize → JSON parses to the same {cols, rows}', () => {
    const frame = encodeResize(132, 50)
    expect(frame[0]).toBe(MSG_RESIZE)
    expect(JSON.parse(decoder.decode(frame.subarray(1)))).toEqual({ cols: 132, rows: 50 })
  })

  it('encodeHostKeyVerifyResponse → JSON parses to the same {accepted}', () => {
    const frame = encodeHostKeyVerifyResponse(true)
    expect(JSON.parse(decoder.decode(frame.subarray(1)))).toEqual({ accepted: true })
  })
})
