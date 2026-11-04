import type { ITheme } from '@xterm/xterm'
import * as React from 'react'

export type TerminalThemeName = 'dark' | 'light' | 'solarizedDark' | 'solarizedLight'

export interface TerminalSettings {
  theme: TerminalThemeName
  /** Custom colors on top of the theme; null keeps the theme's color. */
  foreground: string | null
  background: string | null
  /** CSS font-family list; empty uses {@link DEFAULT_FONT_FAMILY}. */
  fontFamily: string
  fontSize: number
  scrollbar: boolean
  /** Space around the terminal, in pixels. */
  padding: number
  copyOnSelect: boolean
  /** Ctrl+Shift+C / Ctrl+Shift+V copy and paste. */
  clipboardShortcuts: boolean
}

export const DEFAULT_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
export const FONT_PRESETS: readonly { id: string, family: string }[] = [
  { id: 'system', family: '' },
  { id: 'jetbrains', family: '"JetBrains Mono Variable", monospace' },
]

export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 32
export const MAX_PADDING = 32
export const FONT_SIZES = Array.from({ length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 }, (_, i) => MIN_FONT_SIZE + i)

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  theme: 'dark',
  foreground: null,
  background: null,
  fontFamily: '',
  fontSize: 13,
  scrollbar: true,
  padding: 8,
  copyOnSelect: false,
  clipboardShortcuts: true,
}

export const TERMINAL_THEMES: Record<TerminalThemeName, ITheme> = {
  dark: {
    background: '#0b0d12',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    cursorAccent: '#0b0d12',
    selectionBackground: 'rgba(255, 255, 255, 0.20)',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0, 0, 0, 0.15)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
  },
  solarizedDark: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: 'rgba(147, 161, 161, 0.25)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  solarizedLight: {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selectionBackground: 'rgba(88, 110, 117, 0.20)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
}

const STORAGE_KEY = 'gated.terminal.settings'
const HEX_COLOR = /^#[0-9a-f]{6}$/i

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/** Settings from storage, with every invalid or missing field at its default. */
export function parseTerminalSettings(raw: string | null): TerminalSettings {
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (parsed && typeof parsed === 'object')
      value = parsed as Record<string, unknown>
  }
  catch {}
  const d = DEFAULT_TERMINAL_SETTINGS
  const color = (v: unknown) => (typeof v === 'string' && HEX_COLOR.test(v) ? v : null)
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  return {
    theme: typeof value.theme === 'string' && value.theme in TERMINAL_THEMES ? value.theme as TerminalThemeName : d.theme,
    foreground: color(value.foreground),
    background: color(value.background),
    fontFamily: typeof value.fontFamily === 'string' ? value.fontFamily : d.fontFamily,
    fontSize: clamp(value.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, d.fontSize),
    scrollbar: flag(value.scrollbar, d.scrollbar),
    padding: clamp(value.padding, 0, MAX_PADDING, d.padding),
    copyOnSelect: flag(value.copyOnSelect, d.copyOnSelect),
    clipboardShortcuts: flag(value.clipboardShortcuts, d.clipboardShortcuts),
  }
}

export function terminalTheme(settings: TerminalSettings): ITheme {
  const theme: ITheme = { ...TERMINAL_THEMES[settings.theme] }
  if (settings.foreground)
    theme.foreground = settings.foreground
  if (settings.background) {
    theme.background = settings.background
    theme.cursorAccent = settings.background
  }
  if (!settings.scrollbar) {
    theme.scrollbarSliderBackground = 'transparent'
    theme.scrollbarSliderHoverBackground = 'transparent'
    theme.scrollbarSliderActiveBackground = 'transparent'
  }
  return theme
}

export function terminalFontFamily(settings: TerminalSettings): string {
  return settings.fontFamily.trim() || DEFAULT_FONT_FAMILY
}

function readStorage(): TerminalSettings {
  try {
    return parseTerminalSettings(localStorage.getItem(STORAGE_KEY))
  }
  catch {
    return DEFAULT_TERMINAL_SETTINGS
  }
}

// One shared copy so every open terminal follows a change at once.
let current: TerminalSettings | null = null
const listeners = new Set<() => void>()

function snapshot(): TerminalSettings {
  current ??= readStorage()
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updateTerminalSettings(patch: Partial<TerminalSettings>): void {
  current = parseTerminalSettings(JSON.stringify({ ...snapshot(), ...patch }))
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  }
  catch {}
  for (const listener of listeners)
    listener()
}

/** Terminal settings saved in this browser. */
export function useTerminalSettings(): TerminalSettings {
  return React.useSyncExternalStore(subscribe, snapshot)
}

/** Forget the cached copy; tests only. */
export function resetTerminalSettingsCache(): void {
  current = null
}

export type TerminalShortcut = 'copy' | 'paste' | 'zoom-in' | 'zoom-out' | 'zoom-reset'

/**
 * The gateway shortcut a keyboard event triggers, if any. Plain Ctrl+C and
 * Ctrl+V are left to the remote program (SIGINT, literal next).
 */
export function terminalShortcut(event: KeyboardEvent, settings: TerminalSettings): TerminalShortcut | null {
  const ctrl = event.ctrlKey || event.metaKey
  if (!ctrl || event.altKey)
    return null
  const key = event.key.toLowerCase()
  if (event.shiftKey && settings.clipboardShortcuts) {
    if (key === 'c')
      return 'copy'
    if (key === 'v')
      return 'paste'
  }
  if (key === '=' || key === '+')
    return 'zoom-in'
  if (key === '-' && !event.shiftKey)
    return 'zoom-out'
  if (key === '0' && !event.shiftKey)
    return 'zoom-reset'
  return null
}
