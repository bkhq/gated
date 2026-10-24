import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRecordingStream } from './use-recording-stream'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  static instances: FakeWebSocket[] = []
  static lastConstructorUrl: string | null = null

  url: string
  readyState = 0
  listeners: Record<string, ((event: unknown) => void)[]> = {}

  constructor(url: string) {
    this.url = url
    FakeWebSocket.lastConstructorUrl = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(event: string, cb: (event: unknown) => void): void {
    if (!this.listeners[event])
      this.listeners[event] = []
    this.listeners[event].push(cb)
  }

  dispatch(event: string, payload: unknown): void {
    const cbs = this.listeners[event] ?? []
    for (const cb of cbs)
      cb(payload)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatch('open', new Event('open'))
  }

  emit(data: string): void {
    this.dispatch('message', { data })
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED)
      return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', new Event('close'))
  }

  send(_data: unknown): void {}
}

const realWebSocket = globalThis.WebSocket

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  FakeWebSocket.instances = []
  FakeWebSocket.lastConstructorUrl = null
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  globalThis.WebSocket = realWebSocket
})

describe('useRecordingStream', () => {
  it('returns idle state and does not open a socket when id is undefined', async () => {
    const { result } = renderHook(() => useRecordingStream(undefined, true))
    await flush()
    expect(FakeWebSocket.instances.length).toBe(0)
    expect(result.current).toMatchObject({
      started: false,
      live: false,
      frames: [],
      ended: false,
      readyState: 'closed',
      lastError: null,
    })
  })

  it('returns idle state and does not open a socket when enabled is false', async () => {
    const { result } = renderHook(() => useRecordingStream('rec-1', false))
    await flush()
    expect(FakeWebSocket.instances.length).toBe(0)
    expect(result.current.started).toBe(false)
    expect(result.current.frames).toEqual([])
  })

  it('builds the stream URL from the id', async () => {
    renderHook(() => useRecordingStream('rec/42', true))
    await flush()
    expect(FakeWebSocket.lastConstructorUrl).not.toBeNull()
    // The URL is resolved against location.origin and scheme-promoted to ws[s];
    // we only assert the path is encoded as recordingStreamUrl returns.
    expect(FakeWebSocket.lastConstructorUrl?.endsWith('/admin/api/recordings/rec%2F42/stream')).toBe(true)
  })

  it('advances state through start → data → data → end frames', async () => {
    const { result } = renderHook(() => useRecordingStream('rec-1', true))
    await flush()
    expect(FakeWebSocket.instances.length).toBe(1)
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())

    act(() => ws.emit(JSON.stringify({ start: true, live: true })))
    expect(result.current.started).toBe(true)
    expect(result.current.live).toBe(true)
    expect(result.current.ended).toBe(false)
    expect(result.current.frames).toEqual([])

    act(() => ws.emit(JSON.stringify({ data: { version: 2, width: 80, height: 24 } })))
    act(() => ws.emit(JSON.stringify({ data: [0.1, 'o', 'hi'] })))
    expect(result.current.frames).toEqual([
      { version: 2, width: 80, height: 24 },
      [0.1, 'o', 'hi'],
    ])
    expect(result.current.ended).toBe(false)

    act(() => ws.emit(JSON.stringify({ end: true })))
    expect(result.current.ended).toBe(true)
    expect(result.current.frames.length).toBe(2)
  })

  it('records live=false for a non-live start frame', async () => {
    const { result } = renderHook(() => useRecordingStream('rec-1', true))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emit(JSON.stringify({ start: true, live: false })))
    expect(result.current.started).toBe(true)
    expect(result.current.live).toBe(false)
  })

  it('ignores malformed frames', async () => {
    const { result } = renderHook(() => useRecordingStream('rec-1', true))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emit('not-json'))
    act(() => ws.emit(JSON.stringify({ hello: 'world' })))
    expect(result.current.started).toBe(false)
    expect(result.current.frames).toEqual([])
    expect(result.current.ended).toBe(false)
  })
})
