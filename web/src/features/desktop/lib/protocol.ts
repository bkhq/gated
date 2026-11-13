// Wire format of `GET /api/desktop/{target}`: JSON control messages as text
// frames in both directions, pixels as binary frames from the gateway:
// [kind: u8][x, y, width, height: u16 LE][data].

/** `data` is RGBA, width * height * 4 bytes. */
export const IMAGE_RAW = 1
/** `data` is a JPEG. */
export const IMAGE_JPEG = 2
/** The pointer shape as RGBA; x and y are its hotspot. */
export const IMAGE_CURSOR = 3

const HEADER_BYTES = 9

export interface ImageFrame {
  kind: number
  x: number
  y: number
  width: number
  height: number
  data: Uint8Array
}

export function parseImageFrame(buffer: ArrayBuffer): ImageFrame | null {
  if (buffer.byteLength < HEADER_BYTES)
    return null
  const view = new DataView(buffer)
  return {
    kind: view.getUint8(0),
    x: view.getUint16(1, true),
    y: view.getUint16(3, true),
    width: view.getUint16(5, true),
    height: view.getUint16(7, true),
    data: new Uint8Array(buffer, HEADER_BYTES),
  }
}

export type DesktopState = 'connecting' | 'connected' | 'closed'

export interface ConnectedDetails {
  session_id: string
  /** Target host:port. */
  address: string
  /** Target account; empty for VNC. */
  username: string
  /** Whether clipboard text is passed on, in both directions. */
  clipboard: boolean
}

export type ServerMessage
  = | { type: 'state', state: DesktopState, message?: string, details?: ConnectedDetails }
    | { type: 'resize', width: number, height: number }
    | { type: 'clipboard', text: string }
    | { type: 'bell' }
    | { type: 'error', message: string }
    | { type: 'cursor_default' }
    | { type: 'cursor_hidden' }

const SERVER_TYPES = new Set(['state', 'resize', 'clipboard', 'bell', 'error', 'cursor_default', 'cursor_hidden'])

export function parseServerMessage(text: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return null
    const type = (value as { type?: unknown }).type
    return typeof type === 'string' && SERVER_TYPES.has(type) ? value as ServerMessage : null
  }
  catch {
    return null
  }
}

export type ClientMessage
  = | { type: 'pointer_event', x: number, y: number, buttons: number }
    | { type: 'key_event', keysym?: number, scancode?: number, extended?: boolean, down: boolean }
    | { type: 'wheel_event', x: number, y: number, vertical: boolean, delta: number }
    | { type: 'clipboard', text: string }
    | { type: 'refresh' }
    | { type: 'resize', width: number, height: number }

/**
 * The socket of a desktop session. `size` is the room there is for the
 * desktop; a target that can pick its size starts with it.
 */
export function desktopUrl(targetName: string, account?: string, size?: { width: number, height: number }): string {
  const url = new URL(`/api/desktop/${encodeURIComponent(targetName)}`, location.origin)
  if (account)
    url.searchParams.set('account', account)
  if (size) {
    url.searchParams.set('width', String(Math.floor(size.width)))
    url.searchParams.set('height', String(Math.floor(size.height)))
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export interface Point {
  x: number
  y: number
}

/** A pointer position over the (possibly scaled) canvas, in desktop pixels. */
export function canvasPoint(
  event: { clientX: number, clientY: number },
  rect: { left: number, top: number, width: number, height: number },
  desktop: { width: number, height: number },
): Point {
  if (rect.width <= 0 || rect.height <= 0)
    return { x: 0, y: 0 }
  const scale = (offset: number, shown: number, real: number) =>
    Math.min(Math.max(Math.floor(offset * real / shown), 0), Math.max(real - 1, 0))
  return {
    x: scale(event.clientX - rect.left, rect.width, desktop.width),
    y: scale(event.clientY - rect.top, rect.height, desktop.height),
  }
}

/**
 * `MouseEvent.buttons` as the gateway's mask. The browser orders the bits
 * left, right, middle; the gateway left, middle, right.
 */
export function pointerButtons(buttons: number): number {
  return (buttons & 1) | ((buttons & 4) >> 1) | ((buttons & 2) << 1)
}

/** One notch per wheel event; up and right are positive. */
export function wheelMessage(event: { deltaX: number, deltaY: number }, point: Point): ClientMessage | null {
  const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
  const amount = vertical ? -event.deltaY : event.deltaX
  if (amount === 0)
    return null
  return { type: 'wheel_event', x: point.x, y: point.y, vertical, delta: amount > 0 ? 1 : -1 }
}
