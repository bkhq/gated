import { expect, it } from 'vitest'
import {
  canvasPoint,
  desktopUrl,
  IMAGE_JPEG,
  parseImageFrame,
  parseServerMessage,
  pointerButtons,
  wheelMessage,
} from './protocol'

it('builds the socket URL with the picked account', () => {
  const url = new URL(desktopUrl('desk-01', 'svc admin'))
  expect(url.protocol).toMatch(/^wss?:$/)
  expect(url.pathname).toBe('/api/desktop/desk-01')
  expect(url.searchParams.get('account')).toBe('svc admin')
  expect(new URL(desktopUrl('desk-01')).search).toBe('')
})

it('tells the gateway the size of the window', () => {
  const url = new URL(desktopUrl('desk-01', undefined, { width: 1280.6, height: 720 }))
  expect(url.search).toBe('?width=1280&height=720')
})

it('reads the little-endian header of an image frame', () => {
  const bytes = new Uint8Array([IMAGE_JPEG, 2, 1, 3, 0, 4, 0, 6, 5, 9, 9])
  const frame = parseImageFrame(bytes.buffer)
  expect(frame).toMatchObject({ kind: IMAGE_JPEG, x: 0x0102, y: 3, width: 4, height: 0x0506 })
  expect([...frame!.data]).toEqual([9, 9])
})

it('rejects a frame shorter than its header', () => {
  expect(parseImageFrame(new Uint8Array([1, 0, 0]).buffer)).toBeNull()
})

it('parses control messages and ignores anything else', () => {
  expect(parseServerMessage('{"type":"resize","width":800,"height":600}')).toEqual({ type: 'resize', width: 800, height: 600 })
  expect(parseServerMessage('{"type":"state","state":"closed","message":"bye"}')).toMatchObject({ type: 'state', state: 'closed', message: 'bye' })
  expect(parseServerMessage('{"type":"nope"}')).toBeNull()
  expect(parseServerMessage('not json')).toBeNull()
  expect(parseServerMessage('[]')).toBeNull()
})

it('maps a pointer position on a scaled canvas to desktop pixels', () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 }
  expect(canvasPoint({ clientX: 300, clientY: 200 }, rect, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 })
  // Clamped to the desktop.
  expect(canvasPoint({ clientX: 0, clientY: 0 }, rect, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 })
  expect(canvasPoint({ clientX: 9999, clientY: 9999 }, rect, { width: 800, height: 600 })).toEqual({ x: 799, y: 599 })
  // A canvas that is not laid out yet maps to the origin.
  expect(canvasPoint({ clientX: 5, clientY: 5 }, { left: 0, top: 0, width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 })
})

it('reorders the browser button mask: left, middle, right', () => {
  expect(pointerButtons(0)).toBe(0)
  expect(pointerButtons(1)).toBe(1)
  // Browser: bit 1 is right, bit 2 is middle.
  expect(pointerButtons(2)).toBe(4)
  expect(pointerButtons(4)).toBe(2)
  expect(pointerButtons(7)).toBe(7)
  expect(pointerButtons(8 | 16)).toBe(0)
})

it('turns a wheel event into one notch, up and right positive', () => {
  expect(wheelMessage({ deltaX: 0, deltaY: -120 }, { x: 1, y: 2 })).toEqual({ type: 'wheel_event', x: 1, y: 2, vertical: true, delta: 1 })
  expect(wheelMessage({ deltaX: 0, deltaY: 3 }, { x: 1, y: 2 })).toMatchObject({ vertical: true, delta: -1 })
  expect(wheelMessage({ deltaX: 40, deltaY: 1 }, { x: 1, y: 2 })).toMatchObject({ vertical: false, delta: 1 })
  expect(wheelMessage({ deltaX: 0, deltaY: 0 }, { x: 1, y: 2 })).toBeNull()
})
