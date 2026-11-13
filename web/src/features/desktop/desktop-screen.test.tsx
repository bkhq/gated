import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DesktopScreen } from './desktop-screen'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
  binaryType = ''
  sent: any[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  receive(message: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }))
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED
    act(() => this.onclose?.())
  }
}

const realWebSocket = globalThis.WebSocket
const connected = {
  type: 'state',
  state: 'connected',
  details: { session_id: 's-1', address: '10.0.0.9:5900', username: '', clipboard: false },
}

beforeEach(() => {
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})
afterEach(() => {
  cleanup()
  globalThis.WebSocket = realWebSocket
  vi.restoreAllMocks()
})

function socket(index = 0): FakeWebSocket {
  return FakeWebSocket.instances[index]!
}

function canvas(): HTMLCanvasElement {
  return screen.getByLabelText('desktop.canvas')
}

it('connects to the target with the picked account', () => {
  render(<DesktopScreen targetName="desk-01" account="svc" />)
  const url = new URL(socket().url)
  expect(url.pathname).toBe('/api/desktop/desk-01')
  expect(url.searchParams.get('account')).toBe('svc')
  expect(screen.getByRole('status')).toHaveTextContent('desktop.status.connecting')
})

it('shows the connection state and whether the clipboard is shared', () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive(connected)
  expect(screen.getByRole('status')).toHaveTextContent('desktop.status.connected')
  expect(screen.getByText('desktop.clipboard.off')).toBeInTheDocument()

  cleanup()
  render(<DesktopScreen targetName="desk-01" />)
  socket(1).receive({ ...connected, details: { ...connected.details, clipboard: true } })
  expect(screen.getByText('desktop.clipboard.on')).toBeInTheDocument()
})

it('sizes the canvas to the desktop', async () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive(connected)
  socket().receive({ type: 'resize', width: 800, height: 600 })
  await act(async () => {})
  expect([canvas().width, canvas().height]).toEqual([800, 600])
})

it('sends keys and pointer positions in desktop pixels', async () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive(connected)
  socket().receive({ type: 'resize', width: 800, height: 600 })
  await act(async () => {})
  vi.spyOn(canvas(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300 } as DOMRect)

  fireEvent.keyDown(canvas(), { key: 'a', code: 'KeyA' })
  fireEvent.keyUp(canvas(), { key: 'a', code: 'KeyA' })
  fireEvent.pointerDown(canvas(), { clientX: 200, clientY: 150, buttons: 1 })

  expect(socket().sent).toEqual([
    { type: 'key_event', keysym: 0x61, scancode: 0x1E, extended: false, down: true },
    { type: 'key_event', keysym: 0x61, scancode: 0x1E, extended: false, down: false },
    { type: 'pointer_event', x: 400, y: 300, buttons: 1 },
  ])
})

it('releases held keys when the desktop loses focus', () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive(connected)
  fireEvent.keyDown(canvas(), { key: 'Control', code: 'ControlLeft' })
  fireEvent.blur(canvas())
  expect(socket().sent.at(-1)).toMatchObject({ type: 'key_event', keysym: 0xFFE3, down: false })
})

it('sends Ctrl+Alt+Del from the toolbar', () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive(connected)
  fireEvent.click(screen.getByRole('button', { name: 'desktop.actions.ctrlAltDel' }))
  expect(socket().sent.map(m => [m.keysym, m.down])).toEqual([
    [0xFFE3, true],
    [0xFFE9, true],
    [0xFFFF, true],
    [0xFFFF, false],
    [0xFFE9, false],
    [0xFFE3, false],
  ])
})

it('does not send the clipboard unless the session shares it', () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive(connected)
  fireEvent.paste(canvas(), { clipboardData: { getData: () => 'secret' } })
  expect(socket().sent).toEqual([])

  cleanup()
  render(<DesktopScreen targetName="desk-01" />)
  socket(1).receive({ ...connected, details: { ...connected.details, clipboard: true } })
  fireEvent.paste(canvas(), { clipboardData: { getData: () => 'text' } })
  expect(socket(1).sent).toEqual([{ type: 'clipboard', text: 'text' }])
})

it('shows why the session ended and reconnects on request', () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive({ type: 'error', message: 'Target connection failed: Target refused the connection' })
  socket().receive({ type: 'state', state: 'closed', message: 'The target closed the session' })
  expect(screen.getByRole('status')).toHaveTextContent('desktop.status.closed')
  expect(screen.getByText('Target connection failed: Target refused the connection')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'desktop.actions.reconnect' }))
  expect(FakeWebSocket.instances.length).toBe(2)
  expect(screen.getByRole('status')).toHaveTextContent('desktop.status.connecting')
})

it('treats a dropped socket as a closed session', () => {
  render(<DesktopScreen targetName="desk-01" />)
  socket().receive(connected)
  socket().drop()
  expect(screen.getByRole('status')).toHaveTextContent('desktop.status.closed')
})
