import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSessionMonitorStream } from './use-session-monitor-stream'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  static instances: FakeWebSocket[] = []
  static lastConstructorUrl: string | null = null

  url: string
  readyState = 0
  sent: unknown[] = []
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
    for (const cb of this.listeners[event] ?? [])
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

  send(data: unknown): void {
    this.sent.push(data)
  }
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

describe('useSessionMonitorStream', () => {
  it('does not open a socket when sessionId is undefined', async () => {
    const { result } = renderHook(() => useSessionMonitorStream(undefined, true))
    await flush()
    expect(FakeWebSocket.instances.length).toBe(0)
    expect(result.current.started).toBe(false)
    expect(result.current.readyState).toBe('closed')
  })

  it('builds the monitor URL from the session id', async () => {
    renderHook(() => useSessionMonitorStream('sess-1', true))
    await flush()
    expect(FakeWebSocket.lastConstructorUrl?.endsWith('/admin/api/sessions/sess-1/monitor')).toBe(true)
  })

  it('never sends anything on the socket (read-only)', async () => {
    renderHook(() => useSessionMonitorStream('sess-1', true))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emit(JSON.stringify({ start: true, live: true })))
    expect(ws.sent).toEqual([])
  })

  it('advances through start → data → end frames', async () => {
    const { result } = renderHook(() => useSessionMonitorStream('sess-1', true))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())

    act(() => ws.emit(JSON.stringify({ start: true, live: true })))
    expect(result.current.started).toBe(true)
    expect(result.current.live).toBe(true)

    act(() => ws.emit(JSON.stringify({ data: { version: 2, width: 100, height: 30 } })))
    act(() => ws.emit(JSON.stringify({ data: [0.2, 'o', '$ ls'] })))
    expect(result.current.frames).toEqual([
      { version: 2, width: 100, height: 30 },
      [0.2, 'o', '$ ls'],
    ])

    // The monitor closes with `{ end, reason }`; the extra field is ignored.
    act(() => ws.emit(JSON.stringify({ end: true, reason: 'session is not live or does not exist' })))
    expect(result.current.ended).toBe(true)
  })

  it('marks a non-live session as ended-before-start', async () => {
    const { result } = renderHook(() => useSessionMonitorStream('sess-1', true))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emit(JSON.stringify({ start: true, live: false })))
    act(() => ws.emit(JSON.stringify({ end: true, reason: 'session is not live or does not exist' })))
    expect(result.current.started).toBe(true)
    expect(result.current.live).toBe(false)
    expect(result.current.ended).toBe(true)
  })
})
