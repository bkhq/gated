import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_TERMINAL_SETTINGS,
  parseTerminalSettings,
  resetTerminalSettingsCache,
  terminalFontFamily,
  terminalShortcut,
  terminalTheme,
  updateTerminalSettings,
  useTerminalSettings,
} from './terminal-settings'

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('parseTerminalSettings', () => {
  it('falls back to the defaults for missing or broken storage', () => {
    expect(parseTerminalSettings(null)).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(parseTerminalSettings('{not json')).toEqual(DEFAULT_TERMINAL_SETTINGS)
  })

  it('keeps valid fields and replaces invalid ones', () => {
    const settings = parseTerminalSettings(JSON.stringify({
      theme: 'solarizedLight',
      foreground: '#112233',
      background: 'red',
      fontSize: 99,
      padding: -4,
      copyOnSelect: true,
      scrollbar: 'no',
    }))
    expect(settings).toMatchObject({
      theme: 'solarizedLight',
      foreground: '#112233',
      background: null,
      fontSize: 32,
      padding: 0,
      copyOnSelect: true,
      scrollbar: true,
    })
  })
})

describe('terminalTheme', () => {
  it('applies custom colors and hides the scrollbar on request', () => {
    const theme = terminalTheme({ ...DEFAULT_TERMINAL_SETTINGS, theme: 'light', background: '#000000', scrollbar: false })
    expect(theme.foreground).toBe('#1f2328')
    expect(theme.background).toBe('#000000')
    expect(theme.scrollbarSliderBackground).toBe('transparent')
  })

  it('uses the default font when none is set', () => {
    expect(terminalFontFamily(DEFAULT_TERMINAL_SETTINGS)).toBe(DEFAULT_FONT_FAMILY)
    expect(terminalFontFamily({ ...DEFAULT_TERMINAL_SETTINGS, fontFamily: 'Fira Code' })).toBe('Fira Code')
  })
})

describe('terminalShortcut', () => {
  it('maps Ctrl+Shift+C/V to copy and paste but leaves Ctrl+C to the shell', () => {
    expect(terminalShortcut(key({ key: 'C', ctrlKey: true, shiftKey: true }), DEFAULT_TERMINAL_SETTINGS)).toBe('copy')
    expect(terminalShortcut(key({ key: 'V', ctrlKey: true, shiftKey: true }), DEFAULT_TERMINAL_SETTINGS)).toBe('paste')
    expect(terminalShortcut(key({ key: 'c', ctrlKey: true }), DEFAULT_TERMINAL_SETTINGS)).toBeNull()
    expect(terminalShortcut(key({ key: 'C', ctrlKey: true, shiftKey: true }), { ...DEFAULT_TERMINAL_SETTINGS, clipboardShortcuts: false })).toBeNull()
  })

  it('maps Ctrl+= / Ctrl+- / Ctrl+0 to font zoom', () => {
    expect(terminalShortcut(key({ key: '=', ctrlKey: true }), DEFAULT_TERMINAL_SETTINGS)).toBe('zoom-in')
    expect(terminalShortcut(key({ key: '-', ctrlKey: true }), DEFAULT_TERMINAL_SETTINGS)).toBe('zoom-out')
    expect(terminalShortcut(key({ key: '0', ctrlKey: true }), DEFAULT_TERMINAL_SETTINGS)).toBe('zoom-reset')
    expect(terminalShortcut(key({ key: '=' }), DEFAULT_TERMINAL_SETTINGS)).toBeNull()
  })
})

describe('useTerminalSettings', () => {
  beforeEach(() => {
    localStorage.clear()
    resetTerminalSettingsCache()
  })

  it('applies a change to every terminal and keeps it for the next page load', () => {
    const first = renderHook(() => useTerminalSettings())
    const second = renderHook(() => useTerminalSettings())
    act(() => updateTerminalSettings({ fontSize: 16, theme: 'light' }))
    expect(first.result.current).toMatchObject({ fontSize: 16, theme: 'light' })
    expect(second.result.current).toMatchObject({ fontSize: 16, theme: 'light' })

    resetTerminalSettingsCache()
    expect(renderHook(() => useTerminalSettings()).result.current).toMatchObject({ fontSize: 16, theme: 'light' })
  })
})
