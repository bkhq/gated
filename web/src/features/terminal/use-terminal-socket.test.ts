import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MSG_DATA,
  MSG_HOST_KEY_VERIFY,
  MSG_RESIZE,
  MSG_STATUS,
} from './codec'
import { useTerminalSocket } from './use-terminal-socket'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: FakeWebSocket[] = []
  static lastConstructorUrl: string | null = null

  url: string
  binaryType: BinaryType = 'blob'
  readyState = FakeWebSocket.CONNECTING
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
    const cbs = this.listeners[event] ?? []
    for (const cb of cbs)
      cb(payload)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatch('open', new Event('open'))
  }

  emitBinary(buf: ArrayBuffer): void {
    this.dispatch('message', { data: buf })
  }

  emitText(text: string): void {
    this.dispatch('message', { data: text })
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

  send(data: unknown): void {
    this.sent.push(data)
  }
}

function frame(type: number, body: Uint8Array | string): ArrayBuffer {
  const bytes = typeof body === 'string'
    ? new TextEncoder().encode(body)
    : body
  const buf = new Uint8Array(1 + bytes.length)
  buf[0] = type
  buf.set(bytes, 1)
  return buf.buffer
}

const realWebSocket = globalThis.WebSocket

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array)
    return value
  if (value instanceof ArrayBuffer)
    return new Uint8Array(value)
  throw new Error(`expected binary frame, got ${typeof value}`)
}

describe('useTerminalSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.lastConstructorUrl = null
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = realWebSocket
  })

  it('builds the URL per kind/target and sets binaryType=arraybuffer', async () => {
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 'web-01' }))
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]!
    expect(ws.binaryType).toBe('arraybuffer')
    expect(ws.url.endsWith('/api/ssh/terminal/web-01')).toBe(true)
  })

  it('uses the mysql endpoint for kind=mysql', async () => {
    renderHook(() => useTerminalSocket({ kind: 'mysql', targetName: 'db-1' }))
    await flush()
    expect(FakeWebSocket.lastConstructorUrl?.endsWith('/api/mysql/terminal/db-1')).toBe(true)
  })

  it('uses the postgres endpoint for kind=postgres', async () => {
    renderHook(() => useTerminalSocket({ kind: 'postgres', targetName: 'pg-1' }))
    await flush()
    expect(FakeWebSocket.lastConstructorUrl?.endsWith('/api/postgres/terminal/pg-1')).toBe(true)
  })

  it('encodes special chars in the target name', async () => {
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 'web 01/extra' }))
    await flush()
    expect(FakeWebSocket.lastConstructorUrl?.endsWith('/api/ssh/terminal/web%2001%2Fextra')).toBe(true)
  })

  it('promotes https → wss for same-origin paths', async () => {
    const restore = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: new URL('https://example.test/ui/'),
    })
    try {
      renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 'web-01' }))
      await flush()
      expect(FakeWebSocket.lastConstructorUrl?.startsWith('wss://')).toBe(true)
    }
    finally {
      if (restore)
        Object.defineProperty(window, 'location', restore)
    }
  })

  it('transitions readyState connecting → open', async () => {
    const hook = renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't' }))
    await flush()
    expect(hook.result.current.readyState).toBe('connecting')
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    expect(hook.result.current.readyState).toBe('open')
  })

  it('routes 0x00 DATA frames to onData with the payload slice', async () => {
    const onData = vi.fn()
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't', onData }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emitBinary(frame(MSG_DATA, new Uint8Array([0x68, 0x69]))))

    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData.mock.calls[0]![0]).toEqual(new Uint8Array([0x68, 0x69]))
  })

  it('routes 0x02 STATUS frames to onStatus', async () => {
    const onStatus = vi.fn()
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't', onStatus }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emitBinary(frame(MSG_STATUS, JSON.stringify({ status: 'info', message: 'connecting' }))))

    expect(onStatus).toHaveBeenCalledWith({ status: 'info', message: 'connecting' })
  })

  it('routes 0x03 HOST_KEY_VERIFY frames with camelCase fields', async () => {
    const onHostKeyVerify = vi.fn()
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't', onHostKeyVerify }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emitBinary(frame(MSG_HOST_KEY_VERIFY, JSON.stringify({
      status: 'host_key_verify',
      algorithm: 'ssh-ed25519',
      key_base64: 'AAA',
    }))))

    expect(onHostKeyVerify).toHaveBeenCalledWith({ algorithm: 'ssh-ed25519', keyBase64: 'AAA' })
  })

  it('ignores text messages (only binary frames carry the protocol)', async () => {
    const onData = vi.fn()
    const onStatus = vi.fn()
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't', onData, onStatus }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emitText('plain text'))
    expect(onData).not.toHaveBeenCalled()
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('silently drops malformed status frames (decodeFrame returns null)', async () => {
    const onStatus = vi.fn()
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't', onStatus }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emitBinary(frame(MSG_STATUS, '{not json')))
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('sendInput emits a 0x00 DATA frame with the payload bytes', async () => {
    const hook = renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't' }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => hook.result.current.sendInput(new Uint8Array([0x41, 0x42])))

    expect(ws.sent).toHaveLength(1)
    const sent = asBytes(ws.sent[0])
    expect(sent[0]).toBe(MSG_DATA)
    expect(sent.subarray(1)).toEqual(new Uint8Array([0x41, 0x42]))
  })

  it('sendInput is a no-op while the socket is not OPEN', async () => {
    const hook = renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't' }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    // not yet open
    act(() => hook.result.current.sendInput(new Uint8Array([1, 2])))
    expect(ws.sent).toHaveLength(0)
  })

  it('sendResize clamps mysql/postgres to u16 max', async () => {
    const hook = renderHook(() => useTerminalSocket({ kind: 'mysql', targetName: 't' }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => hook.result.current.sendResize(70000, 24))

    expect(ws.sent).toHaveLength(1)
    const sent = asBytes(ws.sent[0])
    expect(sent[0]).toBe(MSG_RESIZE)
    expect(JSON.parse(new TextDecoder().decode(sent.subarray(1))))
      .toEqual({ cols: 0xFFFF, rows: 24 })
  })

  it('sendResize allows large u32 values for ssh', async () => {
    const hook = renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't' }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => hook.result.current.sendResize(70000, 70000))
    const sent = asBytes(ws.sent[0])
    expect(JSON.parse(new TextDecoder().decode(sent.subarray(1))))
      .toEqual({ cols: 70000, rows: 70000 })
  })

  it('sendHostKeyDecision emits a 0x03 frame with {accepted}', async () => {
    const hook = renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't' }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => hook.result.current.sendHostKeyDecision(true))

    const sent = asBytes(ws.sent[0])
    expect(sent[0]).toBe(MSG_HOST_KEY_VERIFY)
    expect(JSON.parse(new TextDecoder().decode(sent.subarray(1)))).toEqual({ accepted: true })
  })

  it('reconnects after an unexpected close (exponential backoff)', async () => {
    renderHook(() => useTerminalSocket({
      kind: 'ssh',
      targetName: 't',
      reconnectBaseMs: 5,
      reconnectMaxMs: 50,
    }))
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const first = FakeWebSocket.instances[0]!
    act(() => first.open())
    act(() => first.closeRemote())

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    })
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it.each(['closed', 'error', 'rate_limited'])(
    'does NOT reconnect after a terminal status frame (%s)',
    async (status) => {
      const hook = renderHook(() => useTerminalSocket({
        kind: 'ssh',
        targetName: 't',
        reconnectBaseMs: 5,
        reconnectMaxMs: 50,
      }))
      await flush()
      const ws = FakeWebSocket.instances[0]!
      act(() => ws.open())
      act(() => ws.emitBinary(frame(MSG_STATUS, JSON.stringify({ status, message: 'bye' }))))
      act(() => ws.closeRemote())

      await act(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 80))
      })
      expect(FakeWebSocket.instances.length).toBe(1)
      expect(hook.result.current.terminationReason).toEqual({ status, message: 'bye' })
    },
  )

  it('non-terminal status frames (e.g. info) do not block reconnect', async () => {
    renderHook(() => useTerminalSocket({
      kind: 'ssh',
      targetName: 't',
      reconnectBaseMs: 5,
      reconnectMaxMs: 50,
    }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => ws.emitBinary(frame(MSG_STATUS, JSON.stringify({ status: 'info', message: 'pty allocated' }))))
    act(() => ws.closeRemote())

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    })
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('close() stops the socket and cancels reconnect', async () => {
    const hook = renderHook(() => useTerminalSocket({
      kind: 'ssh',
      targetName: 't',
      reconnectBaseMs: 5,
      reconnectMaxMs: 50,
    }))
    await flush()
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    act(() => hook.result.current.close())
    act(() => ws.closeRemote())

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 40))
    })
    expect(FakeWebSocket.instances.length).toBe(1)
  })

  it('does not connect when enabled=false', async () => {
    renderHook(() => useTerminalSocket({ kind: 'ssh', targetName: 't', enabled: false }))
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('unmount aborts and does not reconnect', async () => {
    const hook = renderHook(() => useTerminalSocket({
      kind: 'ssh',
      targetName: 't',
      reconnectBaseMs: 5,
      reconnectMaxMs: 50,
    }))
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]!
    act(() => ws.open())
    hook.unmount()

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 60))
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
