import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSocket } from './use-websocket'

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

  closeRemote(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', new Event('close'))
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED)
      return
    this.closeRemote()
  }

  send(_data: unknown): void {}
}

const realWebSocket = globalThis.WebSocket

async function flush(): Promise<void> {
  // give React time to commit effects after a render in a real-timer test
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

describe('useWebSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.lastConstructorUrl = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = realWebSocket
  })

  it('decodes JSON messages and invokes onMessage', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket<{ kind: string }>({
      url: '/admin/api/sessions/changes',
      onMessage,
    }))

    await flush()
    expect(FakeWebSocket.instances.length).toBe(1)
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emit(JSON.stringify({ kind: 'session.added' })))

    expect(onMessage).toHaveBeenCalledWith({ kind: 'session.added' })
  })

  it('reconnects after the socket closes (exponential backoff)', async () => {
    renderHook(() => useWebSocket({
      url: '/admin/api/sessions/changes',
      reconnectBaseMs: 5,
      reconnectMaxMs: 50,
    }))

    await flush()
    expect(FakeWebSocket.instances.length).toBe(1)
    const first = FakeWebSocket.instances[0]!
    act(() => first.open())

    // remote drops the connection — hook should schedule a reconnect
    act(() => first.closeRemote())
    expect(FakeWebSocket.instances.length).toBe(1)

    // wait past the first backoff (5ms) for the reconnect to fire
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    })
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('does not reconnect after explicit unmount', async () => {
    const hook = renderHook(() => useWebSocket({
      url: '/admin/api/sessions/changes',
      reconnectBaseMs: 5,
      reconnectMaxMs: 50,
    }))

    await flush()
    expect(FakeWebSocket.instances.length).toBe(1)
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())

    hook.unmount()
    // wait longer than the would-be backoff; no new socket should be created
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 80))
    })
    expect(FakeWebSocket.instances.length).toBe(1)
  })

  it('promotes https → wss for same-origin paths', async () => {
    const restore = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: new URL('https://example.test/ui/'),
    })
    try {
      renderHook(() => useWebSocket({ url: '/admin/api/sessions/changes' }))
      await flush()
      expect(FakeWebSocket.lastConstructorUrl).not.toBeNull()
      expect(FakeWebSocket.lastConstructorUrl?.startsWith('wss://')).toBe(true)
    }
    finally {
      if (restore)
        Object.defineProperty(window, 'location', restore)
    }
  })
})

describe('useWebSocket url changes', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.lastConstructorUrl = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = realWebSocket
  })

  it('closes the old socket and connects to the new url when the url changes', async () => {
    const hook = renderHook(
      ({ id }: { id: string }) => useWebSocket({ url: () => `/admin/api/sessions/${id}/monitor` }),
      { initialProps: { id: 'a' } },
    )

    await flush()
    expect(FakeWebSocket.instances.length).toBe(1)
    const first = FakeWebSocket.instances[0]!
    act(() => first.open())
    expect(first.url).toContain('/sessions/a/monitor')

    hook.rerender({ id: 'b' })
    await flush()

    expect(first.readyState).toBe(FakeWebSocket.CLOSED)
    expect(FakeWebSocket.instances.length).toBe(2)
    expect(FakeWebSocket.lastConstructorUrl).toContain('/sessions/b/monitor')
  })
})
