import type { ClientMessage } from './protocol'

// X11 keysyms of the keys `KeyboardEvent.key` names.
const NAMED_KEYSYMS: Record<string, number> = {
  Backspace: 0xFF08,
  Tab: 0xFF09,
  Enter: 0xFF0D,
  Pause: 0xFF13,
  ScrollLock: 0xFF14,
  Escape: 0xFF1B,
  Home: 0xFF50,
  ArrowLeft: 0xFF51,
  ArrowUp: 0xFF52,
  ArrowRight: 0xFF53,
  ArrowDown: 0xFF54,
  PageUp: 0xFF55,
  PageDown: 0xFF56,
  End: 0xFF57,
  PrintScreen: 0xFF61,
  Insert: 0xFF63,
  ContextMenu: 0xFF67,
  NumLock: 0xFF7F,
  CapsLock: 0xFFE5,
  AltGraph: 0xFE03,
  Delete: 0xFFFF,
}

// Modifiers by physical key, so left and right stay distinct.
const MODIFIER_KEYSYMS: Record<string, number> = {
  ShiftLeft: 0xFFE1,
  ShiftRight: 0xFFE2,
  ControlLeft: 0xFFE3,
  ControlRight: 0xFFE4,
  AltLeft: 0xFFE9,
  AltRight: 0xFFEA,
  MetaLeft: 0xFFEB,
  MetaRight: 0xFFEC,
}

const F1_KEYSYM = 0xFFBE

// PC/AT set 1 make codes by `KeyboardEvent.code`. `E` marks the E0 prefix.
const E = 0x100
const SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0A,
  Digit0: 0x0B,
  Minus: 0x0C,
  Equal: 0x0D,
  Backspace: 0x0E,
  Tab: 0x0F,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1A,
  BracketRight: 0x1B,
  Enter: 0x1C,
  ControlLeft: 0x1D,
  KeyA: 0x1E,
  KeyS: 0x1F,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2A,
  Backslash: 0x2B,
  KeyZ: 0x2C,
  KeyX: 0x2D,
  KeyC: 0x2E,
  KeyV: 0x2F,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3A,
  F1: 0x3B,
  F2: 0x3C,
  F3: 0x3D,
  F4: 0x3E,
  F5: 0x3F,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4A,
  Numpad4: 0x4B,
  Numpad5: 0x4C,
  Numpad6: 0x4D,
  NumpadAdd: 0x4E,
  Numpad1: 0x4F,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  NumpadEnter: E | 0x1C,
  ControlRight: E | 0x1D,
  NumpadDivide: E | 0x35,
  PrintScreen: E | 0x37,
  AltRight: E | 0x38,
  Home: E | 0x47,
  ArrowUp: E | 0x48,
  PageUp: E | 0x49,
  ArrowLeft: E | 0x4B,
  ArrowRight: E | 0x4D,
  End: E | 0x4F,
  ArrowDown: E | 0x50,
  PageDown: E | 0x51,
  Insert: E | 0x52,
  Delete: E | 0x53,
  MetaLeft: E | 0x5B,
  MetaRight: E | 0x5C,
  ContextMenu: E | 0x5D,
}

function keysymFor(key: string, code: string): number | undefined {
  const modifier = MODIFIER_KEYSYMS[code]
  if (modifier !== undefined)
    return modifier
  const named = NAMED_KEYSYMS[key]
  if (named !== undefined)
    return named
  const fn = /^F(\d{1,2})$/.exec(key)
  if (fn) {
    const n = Number(fn[1])
    return n >= 1 && n <= 24 ? F1_KEYSYM + n - 1 : undefined
  }
  // A single character, surrogate pairs included.
  const chars = [...key]
  if (chars.length !== 1)
    return undefined
  const codePoint = key.codePointAt(0)!
  if (codePoint < 0x20 || (codePoint >= 0x7F && codePoint < 0xA0))
    return undefined
  // Latin-1 keysyms equal the code point; the rest live at 0x01000000.
  return codePoint <= 0xFF ? codePoint : 0x01000000 | codePoint
}

/**
 * A key press or release for the gateway: the character under this
 * browser's layout (VNC uses it) and the physical key (RDP uses it). Null
 * when neither is known.
 */
export function keyMessage(event: { key: string, code: string }, down: boolean): ClientMessage | null {
  const keysym = keysymFor(event.key, event.code)
  const scancode = SCANCODES[event.code]
  if (keysym === undefined && scancode === undefined)
    return null
  return {
    type: 'key_event',
    ...(keysym === undefined ? {} : { keysym }),
    ...(scancode === undefined ? {} : { scancode: scancode & 0xFF, extended: (scancode & E) !== 0 }),
    down,
  }
}

function invert(table: Record<string, number>): Map<number, string> {
  return new Map(Object.entries(table).map(([name, value]) => [value, name]))
}

const KEYSYM_NAMES = new Map([...invert(NAMED_KEYSYMS), ...invert(MODIFIER_KEYSYMS)])
const SCANCODE_NAMES = invert(SCANCODES)

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`
}

/** What to call a recorded keysym: the character it types or the key's name. */
export function keysymLabel(keysym: number): string {
  const named = KEYSYM_NAMES.get(keysym)
  if (named !== undefined)
    return named
  if (keysym >= F1_KEYSYM && keysym < F1_KEYSYM + 24)
    return `F${keysym - F1_KEYSYM + 1}`
  if (keysym === 0x20)
    return 'Space'
  if ((keysym > 0x20 && keysym < 0x7F) || (keysym >= 0xA0 && keysym <= 0xFF))
    return String.fromCodePoint(keysym)
  if (keysym > 0x01000000 && keysym <= 0x0110FFFF)
    return String.fromCodePoint(keysym & 0xFFFFFF)
  return hex(keysym)
}

/** What to call a recorded set-1 scancode: the name of the physical key. */
export function scancodeLabel(code: number, extended: boolean): string {
  return SCANCODE_NAMES.get(extended ? E | code : code) ?? hex(code)
}
