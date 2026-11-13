import { expect, it } from 'vitest'
import { keyMessage, keysymLabel, scancodeLabel } from './keys'

it('sends the character as a keysym and the key position as a scancode', () => {
  expect(keyMessage({ key: 'a', code: 'KeyA' }, true)).toEqual({ type: 'key_event', keysym: 0x61, scancode: 0x1E, extended: false, down: true })
  expect(keyMessage({ key: 'A', code: 'KeyA' }, false)).toMatchObject({ keysym: 0x41, scancode: 0x1E, down: false })
  expect(keyMessage({ key: 'é', code: 'Digit2' }, true)).toMatchObject({ keysym: 0xE9, scancode: 0x03 })
})

it('uses the Unicode keysym range outside Latin-1', () => {
  expect(keyMessage({ key: '€', code: 'KeyE' }, true)).toMatchObject({ keysym: 0x010020AC })
  expect(keyMessage({ key: '中', code: '' }, true)).toEqual({ type: 'key_event', keysym: 0x01004E2D, down: true })
})

it('maps named keys', () => {
  expect(keyMessage({ key: 'Enter', code: 'Enter' }, true)).toMatchObject({ keysym: 0xFF0D, scancode: 0x1C, extended: false })
  expect(keyMessage({ key: 'Enter', code: 'NumpadEnter' }, true)).toMatchObject({ keysym: 0xFF0D, scancode: 0x1C, extended: true })
  expect(keyMessage({ key: 'ArrowLeft', code: 'ArrowLeft' }, true)).toMatchObject({ keysym: 0xFF51, scancode: 0x4B, extended: true })
  expect(keyMessage({ key: 'F5', code: 'F5' }, true)).toMatchObject({ keysym: 0xFFC2, scancode: 0x3F })
  expect(keyMessage({ key: 'Delete', code: 'Delete' }, true)).toMatchObject({ keysym: 0xFFFF, scancode: 0x53, extended: true })
})

it('tells left and right modifiers apart', () => {
  expect(keyMessage({ key: 'Shift', code: 'ShiftLeft' }, true)).toMatchObject({ keysym: 0xFFE1, scancode: 0x2A })
  expect(keyMessage({ key: 'Shift', code: 'ShiftRight' }, true)).toMatchObject({ keysym: 0xFFE2, scancode: 0x36 })
  expect(keyMessage({ key: 'Control', code: 'ControlRight' }, true)).toMatchObject({ keysym: 0xFFE4, scancode: 0x1D, extended: true })
  expect(keyMessage({ key: 'Alt', code: 'AltLeft' }, true)).toMatchObject({ keysym: 0xFFE9, scancode: 0x38, extended: false })
  expect(keyMessage({ key: 'Meta', code: 'MetaLeft' }, true)).toMatchObject({ keysym: 0xFFEB, scancode: 0x5B, extended: true })
})

it('drops keys it cannot name', () => {
  expect(keyMessage({ key: 'Unidentified', code: '' }, true)).toBeNull()
  expect(keyMessage({ key: 'Dead', code: 'Quote' }, true)).toMatchObject({ scancode: 0x28 })
  expect(keyMessage({ key: 'Dead', code: 'Quote' }, true)).not.toHaveProperty('keysym')
})

it('names recorded keys', () => {
  expect(keysymLabel(0x61)).toBe('a')
  expect(keysymLabel(0x20)).toBe('Space')
  expect(keysymLabel(0xFF0D)).toBe('Enter')
  expect(keysymLabel(0xFFE3)).toBe('ControlLeft')
  expect(keysymLabel(0xFFC9)).toBe('F12')
  expect(keysymLabel(0x01004E2D)).toBe('\u4E2D')
  expect(keysymLabel(0xFE20)).toBe('0xFE20')
  expect(scancodeLabel(0x1E, false)).toBe('KeyA')
  expect(scancodeLabel(0x1D, true)).toBe('ControlRight')
  expect(scancodeLabel(0x7F, false)).toBe('0x7F')
})
